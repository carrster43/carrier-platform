/**
 * Free days before payment is required. Long enough to produce a first report,
 * which is the moment the app proves itself.
 *
 * A parameter rather than a constant, because both apps also hardcode this
 * number inside their Edge Functions and the pair drifting apart was a real
 * defect on Flare's punch list. One place to change it on the client side is
 * the most this layer can fix; the Deno side is documented in each function.
 */
export const DEFAULT_TRIAL_DAYS = 14;
export function evaluateAccess(profile, { trialDays = DEFAULT_TRIAL_DAYS, now = new Date() } = {}) {
    if (profile.subscription_status === "active") {
        // The status alone is not proof. RevenueCat fires CANCELLATION when
        // auto-renew goes off and EXPIRATION when access actually ends, and the
        // webhook deliberately leaves the status at "active" in between so the
        // paid-for remainder is honoured. If the EXPIRATION event is ever dropped,
        // this date is what stops the row from granting access forever.
        const periodEnd = profile.current_period_end
            ? new Date(profile.current_period_end)
            : null;
        if (periodEnd && periodEnd.getTime() <= now.getTime()) {
            return { allowed: false, daysUsed: 0, daysLeft: 0, reason: "trial_expired" };
        }
        return { allowed: true, daysUsed: 0, daysLeft: 0, reason: "subscribed" };
    }
    const started = new Date(profile.created_at);
    const msPerDay = 24 * 60 * 60 * 1000;
    const daysUsed = Math.max(0, Math.floor((now.getTime() - started.getTime()) / msPerDay));
    const daysLeft = Math.max(0, trialDays - daysUsed);
    // A lapsed payment is not an expired trial — it needs a billing fix, not a
    // second purchase.
    if (profile.subscription_status === "past_due") {
        return { allowed: false, daysUsed, daysLeft: 0, reason: "past_due" };
    }
    return daysLeft > 0
        ? { allowed: true, daysUsed, daysLeft, reason: "trial" }
        : { allowed: false, daysUsed, daysLeft: 0, reason: "trial_expired" };
}
/** The user's calendar date, not the server's. */
export function localToday(d = new Date()) {
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${d.getFullYear()}-${m}-${day}`;
}
