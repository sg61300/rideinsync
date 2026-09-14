import { test } from "node:test";
import assert from "node:assert/strict";
import { compactBarStyle, compactTextStyle } from "./SosAlertCard";

// Regression guard for the founder-reported bug: on a ~360px phone the compact
// SOS bar's text column collapsed to ~180px, wrapping "Gaurav P. needs help"
// one word per line. The fix is style-only: the bar wraps, and the text column
// gets a 12rem preferred width so the actions drop below it instead of
// crushing it. If either value changes the collapse can silently return.
test("compact SOS bar wraps so the text column is never crushed on a phone", () => {
  assert.equal(compactBarStyle.flexWrap, "wrap");
});

test("compact SOS bar text column keeps a 12rem preferred width and minWidth:0", () => {
  assert.equal(compactTextStyle.flex, "1 1 12rem");
  assert.equal(compactTextStyle.minWidth, 0);
});
