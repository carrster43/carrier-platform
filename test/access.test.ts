/**
 * Tests for the access gate that every app in the fleet runs.
 *
 * Twenty apps carry a lib/access.ts, and all twenty are thin shims around this
 * file. Thirty-two pin the package. Nothing tested it. A defect here is a
 * defect in every app at once, and the two failure directions are not
 * symmetric: locking out a paying customer costs a refund and a review, while
 * granting access forever costs revenue silently and indefinitely.
 *
 * Both directions are pinned below.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_TRIAL_DAYS,
  evaluateAccess,
  localToday,
} from "../src/billing/access.ts";
import type { BillingProfile } from "../src/billing/types.ts";

const NOW = new Date("2026-09-08T12:00:00Z");
const DAY = 24 * 60 * 60 * 1000;

function profile(over: Partial<BillingProfile> = {}): BillingProfile {
  return {
    created_at: NOW.toISOString(),
    subscription_status: "none",
    current_period_end: null,
    ...over,
  } as BillingProfile;
}

const ago = (days: number) => new Date(NOW.getTime() - days * DAY).toISOString();
const ahead = (days: number) => new Date(NOW.getTime() + days * DAY).toISOString();

// ---------------------------------------------------------------------------
// the subscribed path, and the guard behind it
// ---------------------------------------------------------------------------

test("an active subscription with a future period end is allowed", () => {
  const a = evaluateAccess(
    profile({ subscription_status: "active", current_period_end: ahead(20) }),
    { now: NOW });
  assert.equal(a.allowed, true);
  assert.equal(a.reason, "subscribed");
});

test("an active subscription with no period end recorded is still allowed", () => {
  const a = evaluateAccess(
    profile({ subscription_status: "active", current_period_end: null }),
    { now: NOW });
  assert.equal(a.allowed, true);
  assert.equal(a.reason, "subscribed");
});

test("an ACTIVE row whose period has ended is DENIED, not granted forever", () => {
  // The most valuable line in the file. RevenueCat leaves the status at
  // "active" between CANCELLATION and EXPIRATION so the paid remainder is
  // honoured. If the EXPIRATION webhook is ever dropped, this date is the only
  // thing stopping the row granting access indefinitely, and the failure is
  // silent: nothing errors, revenue just stops arriving.
  const a = evaluateAccess(
    profile({ subscription_status: "active", current_period_end: ago(1) }),
    { now: NOW });
  assert.equal(a.allowed, false);
  assert.equal(a.reason, "trial_expired");
});

test("the period end boundary is inclusive: ending exactly now denies", () => {
  const a = evaluateAccess(
    profile({ subscription_status: "active",
              current_period_end: NOW.toISOString() }),
    { now: NOW });
  assert.equal(a.allowed, false);
});

// ---------------------------------------------------------------------------
// past_due is a billing problem, not an expired trial
// ---------------------------------------------------------------------------

test("past_due reports past_due, and never trial_expired", () => {
  // The reason routes the UI. A lapsed card needs a billing fix, not a second
  // purchase, and telling somebody their trial ended when they have been
  // paying for a year is the kind of message that ends the relationship.
  const a = evaluateAccess(
    profile({ subscription_status: "past_due", created_at: ago(400) }),
    { now: NOW });
  assert.equal(a.allowed, false);
  assert.equal(a.reason, "past_due");
});

test("past_due still reports how long they have been with you", () => {
  const a = evaluateAccess(
    profile({ subscription_status: "past_due", created_at: ago(400) }),
    { now: NOW });
  assert.equal(a.daysUsed, 400, "daysUsed must survive so the UI can say it");
});

// ---------------------------------------------------------------------------
// the trial
// ---------------------------------------------------------------------------

test("the default trial is 14 days", () => {
  assert.equal(DEFAULT_TRIAL_DAYS, 14);
});

test("a brand new account is on day zero with the full trial left", () => {
  const a = evaluateAccess(profile({ created_at: NOW.toISOString() }), { now: NOW });
  assert.equal(a.allowed, true);
  assert.equal(a.reason, "trial");
  assert.equal(a.daysUsed, 0);
  assert.equal(a.daysLeft, 14);
});

test("the last day of the trial still works, and the day after does not", () => {
  // Off by one here either bills somebody a day early or gives a free day to
  // everybody. The boundary is pinned in both directions.
  const last = evaluateAccess(profile({ created_at: ago(13) }), { now: NOW });
  assert.equal(last.allowed, true);
  assert.equal(last.daysLeft, 1);

  const over = evaluateAccess(profile({ created_at: ago(14) }), { now: NOW });
  assert.equal(over.allowed, false);
  assert.equal(over.reason, "trial_expired");
  assert.equal(over.daysLeft, 0);
});

test("daysLeft never goes negative, however long ago they signed up", () => {
  const a = evaluateAccess(profile({ created_at: ago(900) }), { now: NOW });
  assert.equal(a.daysLeft, 0);
  assert.equal(a.daysUsed, 900);
});

test("a trialDays override is honoured, which is how each app sets its own", () => {
  const a = evaluateAccess(profile({ created_at: ago(20) }),
                           { trialDays: 30, now: NOW });
  assert.equal(a.allowed, true);
  assert.equal(a.daysLeft, 10);
});

test("a clock skewed account from the future uses zero days, not negative", () => {
  // A device clock ahead of the server, or a row written with a future
  // timestamp. daysUsed must clamp at 0 rather than producing daysLeft > the
  // trial length and handing out a longer trial.
  const a = evaluateAccess(profile({ created_at: ahead(5) }), { now: NOW });
  assert.equal(a.daysUsed, 0);
  assert.equal(a.daysLeft, 14, "not 19");
  assert.equal(a.allowed, true);
});

test("part of a day does not count as a whole day used", () => {
  const a = evaluateAccess(
    profile({ created_at: new Date(NOW.getTime() - DAY + 1000).toISOString() }),
    { now: NOW });
  assert.equal(a.daysUsed, 0, "floor, not round");
  assert.equal(a.daysLeft, 14);
});

// ---------------------------------------------------------------------------
// localToday is the USER's calendar date
// ---------------------------------------------------------------------------

test("localToday reads the local calendar, not UTC", () => {
  // Timezone independent assertion: it must use the local getters. Comparing
  // against a hardcoded string would only pass in one timezone.
  const d = new Date("2026-03-01T02:30:00Z");
  const expected = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  assert.equal(localToday(d), expected);
});

test("localToday zero pads a single digit month and day", () => {
  const d = new Date(2026, 0, 5, 12, 0, 0);
  assert.equal(localToday(d), "2026-01-05");
});
