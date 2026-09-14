import { test } from "node:test";
import assert from "node:assert/strict";
import { diffResponders, buildOwnSosStatus, type Responder } from "./sos";
import { buildPushNotifyBody } from "./pushNotifications";

const r = (id: string, name: string, reachedAt: string | null = null): Responder => ({
  id,
  userId: `u-${id}`,
  name,
  reachedAt,
});

// ---- Task 2a: transition detection (drives the raiser's earcon/haptic) ------

test("diffResponders reports a brand-new on-the-way responder", () => {
  const { newOnTheWay, newReached } = diffResponders([], [r("1", "Aarav")]);
  assert.deepEqual(
    newOnTheWay.map((x) => x.id),
    ["1"],
  );
  assert.equal(newReached.length, 0);
});

test("diffResponders reports an existing responder flipping to reached", () => {
  const prev = [r("1", "Aarav")];
  const next = [r("1", "Aarav", "2026-09-14T10:00:00Z")];
  const { newOnTheWay, newReached } = diffResponders(prev, next);
  assert.equal(newOnTheWay.length, 0);
  assert.deepEqual(
    newReached.map((x) => x.id),
    ["1"],
  );
});

test("diffResponders fires nothing when the list is unchanged (no replay)", () => {
  const list = [r("1", "Aarav"), r("2", "Meera", "2026-09-14T10:00:00Z")];
  const { newOnTheWay, newReached } = diffResponders(list, list);
  assert.equal(newOnTheWay.length, 0);
  assert.equal(newReached.length, 0);
});

test("diffResponders treats a new already-reached responder as reached", () => {
  const { newOnTheWay, newReached } = diffResponders([], [r("9", "Kavya", "2026-09-14T10:00:00Z")]);
  assert.equal(newOnTheWay.length, 0);
  assert.deepEqual(
    newReached.map((x) => x.id),
    ["9"],
  );
});

// ---- Task 2b: raiser's own status line --------------------------------------

test("buildOwnSosStatus: 0 responders → waiting", () => {
  assert.equal(buildOwnSosStatus([]), "Waiting for a response…");
});

test("buildOwnSosStatus: 1 on the way", () => {
  assert.equal(buildOwnSosStatus([r("1", "Aarav")]), "Help is coming: Aarav is on the way");
});

test("buildOwnSosStatus: 1 reached wins over on-the-way", () => {
  assert.equal(
    buildOwnSosStatus([r("1", "Aarav"), r("2", "Meera", "2026-09-14T10:00:00Z")]),
    "Meera has reached you",
  );
});

test("buildOwnSosStatus: 2 on the way names the first and counts the rest", () => {
  assert.equal(
    buildOwnSosStatus([r("1", "Aarav"), r("2", "Meera")]),
    "Help is coming: Aarav and 1 other on the way",
  );
});

// ---- Task 2c: push-notify request body --------------------------------------

test("buildPushNotifyBody keeps a plain signal enqueue unchanged (no extra keys)", () => {
  assert.deepEqual(buildPushNotifyBody("ride-1", "sender-1", "hazard"), {
    ride_id: "ride-1",
    sender_user_id: "sender-1",
    kind: "hazard",
  });
});

test("buildPushNotifyBody targets the raiser and carries the detail for sos_response", () => {
  assert.deepEqual(
    buildPushNotifyBody("ride-1", "responder-1", "sos_response", {
      targetUserId: "raiser-1",
      detail: "is on the way.",
    }),
    {
      ride_id: "ride-1",
      sender_user_id: "responder-1",
      kind: "sos_response",
      target_user_id: "raiser-1",
      detail: "is on the way.",
    },
  );
});

test("buildPushNotifyBody omits target_user_id/detail when not provided", () => {
  const body = buildPushNotifyBody("ride-1", "sender-1", "sos_response");
  assert.equal("target_user_id" in body, false);
  assert.equal("detail" in body, false);
});
