// Web Push — subscription management (client → push_subscriptions) and the
// trigger that asks the push-notify Edge Function to notify everyone else in
// a ride. Delivery mechanics per PRD/signals_haptics_plan.md §7a: reaches a
// backgrounded/locked Android phone in a plain browser tab, and an installed
// (Add to Home Screen) iOS 16.4+ PWA — a plain Safari tab never gets push
// regardless of permission granted. isPushSupported reflects that with a
// standard feature-detect, not UA-sniffing, same reasoning as §10's haptics
// detection recommendation.
import { useCallback, useEffect, useState } from "react";
import { supabase } from "./supabase";
import type { PushSubscriptionInsert } from "./models";
import type { SignalKind } from "./signals";

const VAPID_PUBLIC_KEY = import.meta.env.VITE_VAPID_PUBLIC_KEY;

export function isPushSupported(): boolean {
  return (
    typeof window !== "undefined" &&
    "serviceWorker" in navigator &&
    "PushManager" in window &&
    "Notification" in window
  );
}

// applicationServerKey needs raw bytes, not the base64url string VAPID public
// keys are normally shared/copy-pasted as.
function urlBase64ToUint8Array(base64Url: string): Uint8Array {
  const padding = "=".repeat((4 - (base64Url.length % 4)) % 4);
  const base64 = (base64Url + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base64);
  return Uint8Array.from([...raw].map((c) => c.charCodeAt(0)));
}

async function getSubscription(): Promise<PushSubscription | null> {
  if (!isPushSupported()) return null;
  const reg = await navigator.serviceWorker.ready;
  return reg.pushManager.getSubscription();
}

/** Subscribes this device to push for one ride and stores it server-side. */
export async function subscribeToPush(rideId: string, userId: string): Promise<void> {
  if (!VAPID_PUBLIC_KEY) {
    throw new Error("Push isn't configured on this deploy (missing VITE_VAPID_PUBLIC_KEY).");
  }
  const permission = await Notification.requestPermission();
  if (permission !== "granted") throw new Error("Notification permission was denied.");

  const reg = await navigator.serviceWorker.ready;
  const sub =
    (await reg.pushManager.getSubscription()) ??
    (await reg.pushManager.subscribe({
      userVisibleOnly: true,
      // TS's DOM lib types Uint8Array's buffer as ArrayBufferLike (which
      // includes SharedArrayBuffer), not assignable to BufferSource — the
      // actual runtime object is exactly what PushManager expects.
      applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY) as BufferSource,
    }));

  const json = sub.toJSON();
  const keys = json.keys;
  if (!json.endpoint || !keys?.p256dh || !keys?.auth) {
    throw new Error("Push subscription is missing required fields.");
  }

  const row: PushSubscriptionInsert = {
    user_id: userId,
    ride_id: rideId,
    endpoint: json.endpoint,
    p256dh: keys.p256dh,
    auth: keys.auth,
  };
  const { error } = await supabase
    .from("push_subscriptions")
    .upsert(row, { onConflict: "user_id,ride_id,endpoint" });
  if (error) throw error;
}

/** Unsubscribes this device from push for one ride. */
export async function unsubscribeFromPush(rideId: string, userId: string): Promise<void> {
  const sub = await getSubscription();
  if (!sub) return;
  await supabase
    .from("push_subscriptions")
    .delete()
    .eq("endpoint", sub.endpoint)
    .eq("user_id", userId)
    .eq("ride_id", rideId);
  await sub.unsubscribe();
}

export type PushState = {
  supported: boolean;
  permission: NotificationPermission | "unsupported";
  subscribed: boolean;
  loading: boolean;
  error: string | null;
};

/** Drives a per-ride "enable notifications" toggle. */
export function usePushNotifications(
  rideId: string | null,
  userId: string | null,
): PushState & { enable: () => Promise<void>; disable: () => Promise<void> } {
  const supported = isPushSupported();
  const [permission, setPermission] = useState<NotificationPermission | "unsupported">(
    supported ? Notification.permission : "unsupported",
  );
  const [subscribed, setSubscribed] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!supported) return;
    let cancelled = false;
    void getSubscription().then((sub) => {
      if (!cancelled) setSubscribed(Boolean(sub));
    });
    return () => {
      cancelled = true;
    };
  }, [supported, rideId]);

  const enable = useCallback(async () => {
    if (!rideId || !userId) return;
    setLoading(true);
    setError(null);
    try {
      await subscribeToPush(rideId, userId);
      setSubscribed(true);
      setPermission(Notification.permission);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [rideId, userId]);

  const disable = useCallback(async () => {
    if (!rideId || !userId) return;
    setLoading(true);
    setError(null);
    try {
      await unsubscribeFromPush(rideId, userId);
      setSubscribed(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [rideId, userId]);

  return { supported, permission, subscribed, loading, error, enable, disable };
}

/**
 * Fire-and-forget: asks the push-notify Edge Function to notify everyone else
 * in the ride. Best-effort, matching the rest of this codebase's "insert the
 * real thing, don't block on the notify side-effect" pattern (see sos.ts) — a
 * failure here (e.g. the function isn't deployed yet, or the device is
 * offline) never blocks the signal/SOS send it's attached to.
 */
/** Push kinds the Edge Function understands: the four signals plus the
 *  SOS-response notification (Task 2c) that goes to the raiser alone. */
export type PushKind = SignalKind | "sos_response" | "sos_cancelled";

export type TriggerPushOptions = {
  /** When set, the worker notifies only this user's subscriptions (the SOS
   *  raiser), instead of every ride member except the sender. */
  targetUserId?: string;
  /** Body detail phrase, used by the sos_response kind ("is on the way.",
   *  "has reached you."). Ignored by the fixed-copy signal kinds. */
  detail?: string;
};

/**
 * Pure request-body builder for push-notify's client-facing path. Keeps
 * optional fields off the body entirely when unset, so a plain signal enqueue
 * is byte-identical to before this change. Unit-tested.
 */
export function buildPushNotifyBody(
  rideId: string,
  senderUserId: string,
  kind: PushKind,
  opts: TriggerPushOptions = {},
): Record<string, string> {
  const body: Record<string, string> = { ride_id: rideId, sender_user_id: senderUserId, kind };
  if (opts.targetUserId) body.target_user_id = opts.targetUserId;
  if (opts.detail) body.detail = opts.detail;
  return body;
}

export function triggerPushNotify(
  rideId: string,
  senderUserId: string,
  kind: PushKind,
  opts?: TriggerPushOptions,
): void {
  supabase.functions
    .invoke("push-notify", { body: buildPushNotifyBody(rideId, senderUserId, kind, opts) })
    .then(({ error }) => {
      if (error) console.warn("[push] trigger failed", error.message);
    })
    .catch((err) => console.warn("[push] trigger failed", err));
}
