import { test } from "node:test";
import assert from "node:assert/strict";
import { cancelSosAlert, sosCardState } from "./sos";
import { buildPushNotifyBody } from "./pushNotifications";
import { demoSendSos, demoRespond, demoCancelSos, demoAlerts, demoResponses } from "./sosDemo";
// Aliased to scripts/test/supabaseMock.ts by the unit-test bundler. We augment
// it here with rpc/functions to drive cancelSosAlert's fire-and-forget paths.
import { supabase } from "./supabase";

// ---- client wrapper: cancelSosAlert -----------------------------------------

test("cancelSosAlert swallows push + email failures (RPC ok, side-effects reject)", async () => {
  const s = supabase as { rpc?: unknown; functions?: unknown };
  const origRpc = s.rpc;
  const origFns = s.functions;
  let rpcArgs: unknown = null;
  s.rpc = (_fn: string, args: unknown) => {
    rpcArgs = args;
    return Promise.resolve({ data: { id: "alert-1" }, error: null });
  };
  // Both triggerPushNotify and triggerSosEmail invoke this; a rejection must be
  // swallowed so cancelSosAlert still resolves.
  s.functions = { invoke: () => Promise.reject(new Error("side-effect down")) };
  try {
    await assert.doesNotReject(() => cancelSosAlert("alert-1", "ride-1", "user-1"));
    assert.deepEqual(rpcArgs, { p_alert_id: "alert-1" }, "RPC gets the alert id");
    // Let the swallowed rejections settle; an unhandled one would fail the run.
    await new Promise((r) => setTimeout(r, 15));
  } finally {
    s.rpc = origRpc;
    s.functions = origFns;
  }
});

test("cancelSosAlert throws when the RPC itself fails (SOS not cancelled)", async () => {
  const s = supabase as { rpc?: unknown; functions?: unknown };
  const origRpc = s.rpc;
  s.rpc = () => Promise.resolve({ data: null, error: { message: "already resolved" } });
  try {
    await assert.rejects(() => cancelSosAlert("alert-1", "ride-1", "user-1"));
  } finally {
    s.rpc = origRpc;
  }
});

// ---- card visibility: a cancelled alert is a resolved alert ------------------

test("sosCardState hides a cancelled alert (resolved => not visible)", () => {
  // Cancel stamps resolved_at, so `resolved` is true here.
  const { visible, still } = sosCardState({ resolved: true, stayRequestedAt: null }, []);
  assert.equal(visible, false, "cancelled alert card is not shown");
  assert.equal(still, false);
});

test("sosCardState hides a cancelled alert even with responders on the way", () => {
  const { visible } = sosCardState(
    { resolved: true, stayRequestedAt: null },
    [{ reachedAt: null }, { reachedAt: "2026-09-14T10:00:00Z" }],
  );
  assert.equal(visible, false, "resolution wins over any responder state");
});

// ---- push request body for the cancel push ----------------------------------

test("buildPushNotifyBody builds a plain sos_cancelled fanout (no target/detail)", () => {
  const body = buildPushNotifyBody("ride-1", "raiser-1", "sos_cancelled");
  assert.deepEqual(body, { ride_id: "ride-1", sender_user_id: "raiser-1", kind: "sos_cancelled" });
  assert.equal("target_user_id" in body, false);
  assert.equal("detail" in body, false);
});

// ---- demo backend: cancel removes the alert card + its responses ------------

test("demoCancelSos resolves + stamps the alert and drops its responses", async () => {
  const { alertId } = await demoSendSos("ride-x", "user-1");
  await demoRespond(alertId, "ride-x", "user-2");
  assert.equal(demoResponses().filter((r) => r.alert_id === alertId).length, 1, "one responder before cancel");

  await demoCancelSos(alertId, "user-1");

  const alert = demoAlerts().find((a) => a.id === alertId);
  assert.ok(alert, "alert still in store");
  assert.ok(alert!.resolved_at, "resolved_at stamped so the card hides");
  assert.ok(alert!.cancelled_at, "cancelled_at stamped");
  assert.equal(alert!.resolved_by, "user-1", "resolved_by is the raiser");
  assert.deepEqual(
    demoResponses().filter((r) => r.alert_id === alertId),
    [],
    "the alert's responses are cleared so the compact bar vanishes too",
  );
});
