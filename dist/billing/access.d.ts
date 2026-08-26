import type { Access, BillingProfile } from "./types";
/**
 * Free days before payment is required. Long enough to produce a first report,
 * which is the moment the app proves itself.
 *
 * A parameter rather than a constant, because both apps also hardcode this
 * number inside their Edge Functions and the pair drifting apart was a real
 * defect on Flare's punch list. One place to change it on the client side is
 * the most this layer can fix; the Deno side is documented in each function.
 */
export declare const DEFAULT_TRIAL_DAYS = 14;
export declare function evaluateAccess(profile: BillingProfile, { trialDays, now }?: {
    trialDays?: number | undefined;
    now?: Date | undefined;
}): Access;
/** The user's calendar date, not the server's. */
export declare function localToday(d?: Date): string;
