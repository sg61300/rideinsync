import { supabaseConfigured } from "./supabase";
import type { SosAlert, SosResponse } from "./models";
import type { SendSosResult } from "./sos";

// ============================================================================
// Flow 5 SOS — in-memory demo backend. Lets every screen work without Supabase
// keys: state lives in a module-level store and changes are broadcast on an
// EventTarget so the hooks in sos.ts re-derive. All logs are prefixed
// "[sos:demo]". A full page reload clears the store (it is only in memory).
// ============================================================================

/** True only in keyless demo mode; the live path is used otherwise. */
export const isDemoBackend =
  import.meta.env.VITE_DEMO_SESSION === "1" && !supabaseConfigured;

// The seed ride and riders (full UUIDs mirror supabase/seed.sql).
const DEMO_RIDE_ID = "00000000-0000-0000-0000-0000000000b1";
export const SEED_USERS = {
  AARAV: "00000000-0000-0000-0000-0000000000a1",
  MEERA: "00000000-0000-0000-0000-0000000000a2",
  ROHAN: "00000000-0000-0000-0000-0000000000a3", // the demo self
  KAVYA: "00000000-0000-0000-0000-0000000000a4",
} as const;

const NAMES: Record<string, string> = {
  [SEED_USERS.AARAV]: "Aarav",
  [SEED_USERS.MEERA]: "Meera",
  [SEED_USERS.ROHAN]: "Rohan",
  [SEED_USERS.KAVYA]: "Kavya",
};

/** Display name for a seed user, or a generic fallback. */
export function demoName(userId: string): string {
  return NAMES[userId] ?? "A rider";
}

// ---- Store + change bus -----------------------------------------------------

type Store = { alerts: SosAlert[]; responses: SosResponse[] };
const store: Store = { alerts: [], responses: [] };

const bus = new EventTarget();
function emit(): void {
  bus.dispatchEvent(new Event("change"));
}

/** Subscribe to store changes. Returns an unsubscribe function. */
export function subscribe(cb: () => void): () => void {
  bus.addEventListener("change", cb);
  return () => bus.removeEventListener("change", cb);
}

/** Current alerts snapshot (read-only use by the hooks). */
export function demoAlerts(): SosAlert[] {
  return store.alerts;
}

/** Current responses snapshot (read-only use by the hooks). */
export function demoResponses(): SosResponse[] {
  return store.responses;
}

function newId(): string {
  return crypto.randomUUID();
}

function latestOpenAlert(): SosAlert | null {
  for (let i = store.alerts.length - 1; i >= 0; i--) {
    if (!store.alerts[i].resolved_at) return store.alerts[i];
  }
  return null;
}

// ---- Functions mirroring the live library (same signatures) -----------------

export async function demoSendSos(rideId: string, userId: string): Promise<SendSosResult> {
  const alert: SosAlert = {
    id: newId(),
    ride_id: rideId,
    user_id: userId,
    kind: "manual",
    payload: null,
    triggered_at: new Date().toISOString(),
    resolved_at: null,
    resolved_by: null,
    stay_requested_at: null,
    cancelled_at: null,
  };
  store.alerts.push(alert);
  console.info("[sos:demo] alert sent", { alertId: alert.id, rideId, userId });
  emit();
  return { alertId: alert.id, hasLocation: false };
}

export async function demoRespond(alertId: string, rideId: string, userId: string): Promise<void> {
  // Mirror the DB unique(alert_id, user_id) constraint.
  if (store.responses.some((r) => r.alert_id === alertId && r.user_id === userId)) {
    console.warn("[sos:demo] duplicate response rejected", { alertId, userId });
    throw new Error("duplicate response");
  }
  const resp: SosResponse = {
    id: newId(),
    alert_id: alertId,
    ride_id: rideId,
    user_id: userId,
    reached_at: null,
    created_at: new Date().toISOString(),
  };
  store.responses.push(resp);
  console.info("[sos:demo] response sent", { alertId, userId });
  emit();
}

export async function demoMarkReached(responseId: string): Promise<void> {
  const resp = store.responses.find((r) => r.id === responseId);
  if (!resp) {
    console.warn("[sos:demo] reached: response not found", { responseId });
    return;
  }
  resp.reached_at = new Date().toISOString();
  console.info("[sos:demo] reached", { responseId });
  emit();
}

export async function demoStay(alertId: string): Promise<void> {
  const alert = store.alerts.find((a) => a.id === alertId);
  if (!alert) {
    console.warn("[sos:demo] stay: alert not found", { alertId });
    return;
  }
  alert.stay_requested_at = new Date().toISOString();
  console.info("[sos:demo] stay requested", { alertId });
  emit();
}

export async function demoCloseSos(alertId: string, userId: string): Promise<void> {
  const alert = store.alerts.find((a) => a.id === alertId);
  if (!alert) {
    console.warn("[sos:demo] close: alert not found", { alertId });
    return;
  }
  alert.resolved_at = new Date().toISOString();
  alert.resolved_by = userId;
  console.info("[sos:demo] closed", { alertId });
  emit();
}

export async function demoCancelSos(alertId: string, userId: string): Promise<void> {
  const alert = store.alerts.find((a) => a.id === alertId);
  if (!alert) {
    console.warn("[sos:demo] cancel: alert not found", { alertId });
    return;
  }
  const now = new Date().toISOString();
  alert.resolved_at = now;
  alert.resolved_by = userId;
  alert.cancelled_at = now;
  // Drop this alert's responses too, so the demo mirrors "every card vanishes":
  // the compact bar keyed off responders disappears alongside the alert.
  store.responses = store.responses.filter((r) => r.alert_id !== alertId);
  console.info("[sos:demo] cancelled", { alertId });
  emit();
}

// ---- Simulation helpers (drive other riders from the demo controls) ---------

export function raiseAlertFrom(userId: string): void {
  void demoSendSos(DEMO_RIDE_ID, userId);
}

export function respondAs(userId: string): void {
  const alert = latestOpenAlert();
  if (!alert) {
    console.warn("[sos:demo] respondAs: no open alert");
    return;
  }
  void demoRespond(alert.id, alert.ride_id, userId).catch(() => {
    /* duplicate responder — expected, mirrors the unique constraint */
  });
}

export function reachAs(userId: string): void {
  const alert = latestOpenAlert();
  if (!alert) {
    console.warn("[sos:demo] reachAs: no open alert");
    return;
  }
  const resp = store.responses.find((r) => r.alert_id === alert.id && r.user_id === userId);
  if (!resp) {
    console.warn("[sos:demo] reachAs: user has not responded", { userId });
    return;
  }
  void demoMarkReached(resp.id);
}

export function stayLatest(): void {
  const alert = latestOpenAlert();
  if (!alert) {
    console.warn("[sos:demo] stayLatest: no open alert");
    return;
  }
  void demoStay(alert.id);
}

export function resolveLatest(): void {
  const alert = latestOpenAlert();
  if (!alert) {
    console.warn("[sos:demo] resolveLatest: no open alert");
    return;
  }
  void demoCloseSos(alert.id, alert.user_id);
}
