// push-notify — Web Push send path for Flow 4's "notifications" first cut.
// See PRD/signals_haptics_plan.md §7a/§8.
//
// Invoked directly by the client (src/lib/pushNotifications.ts's
// triggerPushNotify) right after a ride_events/sos_alerts insert succeeds —
// not a pg_net database trigger, to avoid needing custom Postgres GUC
// secrets for a hackathon-scale first cut. A trigger-based path (see
// supabase/migrations/0010_push_notifications.sql's header) is the natural
// v2 if "never rely on the client actually calling this" becomes a hard
// requirement.
//
// M4 (docs/scale-readiness-roadmap.md M4.3): this function now has two
// modes, distinguished by the request body:
//   * Default (no `mode`, or any value other than "process_queue") — the
//     client-facing path, contract unchanged from the caller's perspective
//     ({ride_id, sender_user_id, kind} in, JWT-verified against
//     sender_user_id). Instead of sending inline, it now just enqueues a
//     push_jobs row and returns immediately — the slow fanout moves off the
//     request path.
//   * `{"mode": "process_queue"}` — the async worker path. Only reachable
//     by a caller presenting the project's service_role key as its Bearer
//     token (checked below), which only supabase/migrations/
//     0027_push_jobs_queue.sql's pg_cron job does (via a Vault-stored
//     secret) — an ordinary client JWT is rejected here, so this can't be
//     used to bypass the sender-identity check on the default path. Claims
//     a batch of pending push_jobs and runs the *same* subscriber-lookup +
//     Promise.allSettled send + 404/410 cleanup this function used to run
//     inline, byte-for-behavior identical, just relocated and looped per
//     job. Reusing this file instead of deploying a second Edge Function
//     keeps this a one-file, one-deploy change — see the migration header
//     for why pg_net (not a plpgsql/SQL rewrite) has to be the mechanism:
//     the actual `webpush.sendNotification` call needs this file's
//     VAPID/crypto machinery, which has no Postgres equivalent.
//
// ── One-time deploy steps (cannot be done from this repo alone — needs your
//    Supabase project's own CLI login) ──────────────────────────────────────
//   1. Generate a VAPID keypair once:  npx web-push generate-vapid-keys
//   2. Put the public key in your .env.local as VITE_VAPID_PUBLIC_KEY.
//   3. Set the private key + subject as Supabase secrets (never as a client
//      env var):
//        supabase secrets set VAPID_PUBLIC_KEY=<public> VAPID_PRIVATE_KEY=<private> \
//          VAPID_SUBJECT=mailto:you@example.com
//      (SUPABASE_URL / SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY are
//      injected into every Edge Function automatically — nothing to set.)
//   4. Deploy:  supabase functions deploy push-notify
//   5. Run supabase/migrations/0010_push_notifications.sql against your
//      project (supabase db push, or paste it into the SQL editor).
//
// Request body: { ride_id: string; sender_user_id: string; kind: "hazard" |
// "regroup" | "pitstop" | "sos" }. Verifies the caller's JWT actually is
// sender_user_id (so this can't be used to spam push at other riders'
// devices under a spoofed identity), then enqueues a push_jobs row for the
// async worker path to fan out to every *other* subscriber in that ride.
//
// Process-queue request body: { mode: "process_queue" }, Authorization:
// Bearer <service_role_key>. No other fields — it drains whatever's
// pending in push_jobs itself.

import { createClient } from "npm:@supabase/supabase-js@2.45.0";
import webpush from "npm:web-push@3.6.7";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const VAPID_PUBLIC_KEY = Deno.env.get("VAPID_PUBLIC_KEY");
const VAPID_PRIVATE_KEY = Deno.env.get("VAPID_PRIVATE_KEY");
const VAPID_SUBJECT = Deno.env.get("VAPID_SUBJECT") ?? "mailto:hello@rideinsync.app";

if (VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY) {
  webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
}

const serviceClient = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

// How many pending push_jobs one process_queue invocation drains. pg_cron
// ticks every 5s (0027_push_jobs_queue.sql) — generous for this hackathon's
// traffic; revisit if a batch routinely maxes this out.
const QUEUE_BATCH_SIZE = 25;

// `sos_response` (Task 2c) is the one SOS-raiser-only kind: a responder is on
// the way or has reached the rider. Its body copy is decided by the job's
// `detail` string ("is on the way.", "has reached you."), so both cases reuse
// this single kind rather than adding a second.
type SignalKind = "hazard" | "regroup" | "pitstop" | "sos" | "sos_response";
const KIND_TITLE: Record<SignalKind, string> = {
  hazard: "Hazard",
  regroup: "Regroup",
  pitstop: "Pit stop",
  sos: "SOS",
  sos_response: "Help is coming",
};

type PushJobRow = {
  id: string;
  ride_id: string;
  sender_user_id: string;
  kind: SignalKind;
  /** sos_response only: notify this user (the raiser) alone. */
  target_user_id: string | null;
  /** sos_response only: body detail phrase. */
  detail: string | null;
};

function bodyFor(kind: SignalKind, senderName: string, detail: string | null): string {
  switch (kind) {
    case "hazard":
      return `${senderName} flagged a hazard.`;
    case "regroup":
      return `${senderName} called regroup.`;
    case "pitstop":
      return `${senderName} called a pit stop.`;
    case "sos":
      return `${senderName} needs help. Location shared.`;
    case "sos_response":
      return `${senderName} ${detail ?? "is on the way."}`;
  }
}

// The actual send for one job: subscriber lookup, payload build, webpush
// send, and the 404/410 cleanup — unchanged logic from the pre-M4 inline
// version of this function, just parameterized by a job instead of the raw
// request body.
async function sendForJob(job: PushJobRow): Promise<{ sent: number; failed: number }> {
  const { ride_id, sender_user_id, kind, target_user_id, detail } = job;

  // Recipients: a targeted job (sos_response → the raiser) goes to that one
  // user's subscriptions; every other kind fans out to the whole ride except
  // the sender.
  const subQuery = serviceClient
    .from("push_subscriptions")
    .select("endpoint, p256dh, auth")
    .eq("ride_id", ride_id);
  const [{ data: subs, error: subErr }, { data: sender }] = await Promise.all([
    target_user_id
      ? subQuery.eq("user_id", target_user_id)
      : subQuery.neq("user_id", sender_user_id),
    serviceClient.from("profiles").select("display_name").eq("id", sender_user_id).single(),
  ]);
  if (subErr) {
    throw new Error(`subscription lookup failed: ${subErr.message}`);
  }
  if (!subs?.length) return { sent: 0, failed: 0 };

  const senderName = sender?.display_name ?? "A rider";
  const isUrgent = kind === "sos";
  const payload = JSON.stringify({
    title: KIND_TITLE[kind],
    body: bodyFor(kind, senderName, detail),
    // Per §10's push-dedup rules: sos gets a unique tag per event so
    // concurrent SOS cases stack instead of replacing each other; the
    // routine signals share one tag per (ride, kind) so a flurry of the same
    // signal collapses to one notification instead of spamming the tray.
    tag: isUrgent ? `sos-${sender_user_id}-${Date.now()}` : `${kind}-${ride_id}`,
    urgent: isUrgent,
  });

  const results = await Promise.allSettled(
    subs.map(async (s) => {
      try {
        await webpush.sendNotification(
          { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
          payload,
        );
      } catch (err) {
        const statusCode = (err as { statusCode?: number }).statusCode;
        if (statusCode === 404 || statusCode === 410) {
          // Expired/revoked subscription — stop trying it in future sends.
          await serviceClient.from("push_subscriptions").delete().eq("endpoint", s.endpoint);
        } else {
          throw err;
        }
      }
    }),
  );
  const failed = results.filter((r) => r.status === "rejected").length;
  if (failed) console.warn(`[push-notify] job ${job.id}: ${failed}/${subs.length} sends failed`);

  return { sent: subs.length - failed, failed };
}

// process_queue mode: claim a batch of pending push_jobs, send each, mark
// done/failed. One bad job (e.g. a lookup error) never blocks the rest of
// the batch — matches process_ride_close_jobs' per-item try/catch shape
// (0026_close_ride_incremental.sql).
async function processQueue(): Promise<Response> {
  const { data: pending, error: selErr } = await serviceClient
    .from("push_jobs")
    .select("id")
    .eq("status", "pending")
    .order("created_at", { ascending: true })
    .limit(QUEUE_BATCH_SIZE);
  if (selErr) {
    console.error("[push-notify] queue select failed", selErr.message);
    return new Response("Queue select failed", { status: 500 });
  }
  if (!pending?.length) return new Response(JSON.stringify({ processed: 0 }), { status: 200 });

  const ids = pending.map((p) => p.id);
  const { data: claimed, error: claimErr } = await serviceClient
    .from("push_jobs")
    .update({ status: "processing" })
    .eq("status", "pending")
    .in("id", ids)
    .select("id, ride_id, sender_user_id, kind, target_user_id, detail");
  if (claimErr) {
    console.error("[push-notify] queue claim failed", claimErr.message);
    return new Response("Queue claim failed", { status: 500 });
  }

  let sent = 0;
  let failed = 0;
  for (const job of (claimed ?? []) as PushJobRow[]) {
    try {
      const result = await sendForJob(job);
      sent += result.sent;
      failed += result.failed;
      await serviceClient
        .from("push_jobs")
        .update({ status: "done", processed_at: new Date().toISOString() })
        .eq("id", job.id);
    } catch (err) {
      console.error(`[push-notify] job ${job.id} failed`, (err as Error).message ?? err);
      await serviceClient
        .from("push_jobs")
        .update({ status: "failed", processed_at: new Date().toISOString() })
        .eq("id", job.id);
    }
  }

  return new Response(JSON.stringify({ processed: claimed?.length ?? 0, sent, failed }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });
  if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) {
    console.error("[push-notify] VAPID keys not configured — see this file's header");
    return new Response("Push not configured", { status: 500 });
  }

  let body: {
    ride_id?: string;
    sender_user_id?: string;
    kind?: string;
    mode?: string;
    target_user_id?: string;
    detail?: string;
  };
  try {
    body = await req.json();
  } catch {
    return new Response("Invalid JSON", { status: 400 });
  }

  // Process-queue mode: only the pg_cron worker (via its Vault-stored
  // service_role key, 0027_push_jobs_queue.sql) may call this — an ordinary
  // client JWT is not the service_role key and is rejected here.
  if (body.mode === "process_queue") {
    const authHeader = req.headers.get("Authorization") ?? "";
    if (authHeader !== `Bearer ${SERVICE_ROLE_KEY}`) {
      // Silent-drop guard: the pg_cron worker (process_push_queue) reaches
      // this path with the Vault-stored key. If that key does not match this
      // function's SUPABASE_SERVICE_ROLE_KEY, the queue never drains and NO
      // push is ever delivered — with no other signal. On a hosted deploy the
      // usual cause is that 0027's seeded local-dev demo key was not rotated
      // to the hosted project's service_role key (see that migration's
      // header). Log it loudly so this is traceable from the function logs.
      console.error(
        "[push-notify] process_queue REJECTED: caller's bearer token is not this project's " +
          "SUPABASE_SERVICE_ROLE_KEY. push_jobs will NOT drain. On a hosted project, rotate the " +
          "Vault secret 'push_notify_service_role_key' to the hosted service_role key " +
          "(see 0027_push_jobs_queue.sql header).",
      );
      return new Response("Unauthorized", { status: 401 });
    }
    return await processQueue();
  }

  const { ride_id, sender_user_id, kind, target_user_id, detail } = body;
  if (!ride_id || !sender_user_id || !kind || !(kind in KIND_TITLE)) {
    return new Response("Missing or invalid fields", { status: 400 });
  }

  // The caller must be the sender they claim to be — otherwise this endpoint
  // could be used to trigger push at other riders under a spoofed identity.
  const authHeader = req.headers.get("Authorization") ?? "";
  const callerClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
  });
  const { data: caller, error: authErr } = await callerClient.auth.getUser();
  if (authErr || caller.user?.id !== sender_user_id) {
    return new Response("Unauthorized", { status: 401 });
  }

  // M4: enqueue instead of sending inline — the worker path above (driven by
  // pg_cron) does the actual fanout. Returns immediately, same fire-and-forget
  // contract triggerPushNotify already treats this call as.
  const { data: job, error: insertErr } = await serviceClient
    .from("push_jobs")
    .insert({
      ride_id,
      sender_user_id,
      kind,
      target_user_id: target_user_id ?? null,
      detail: detail ?? null,
    })
    .select("id")
    .single();
  if (insertErr) {
    console.error("[push-notify] enqueue failed", insertErr.message);
    return new Response("Enqueue failed", { status: 500 });
  }

  return new Response(JSON.stringify({ enqueued: true, job_id: job.id }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
});
