export type SubscriptionStatus =
  | "trialing"
  | "active"
  | "past_due"
  | "canceled";

/**
 * The only three fields the platform needs to decide entitlement.
 *
 * Deliberately not the app's full Profile. Flare's carries `condition` and
 * Perimeter's carries `cycle_pattern`, and a shared package that knows about
 * either has stopped being a platform. Both apps' Profile types satisfy this
 * structurally without importing it, so nothing has to change to comply.
 */
export interface BillingProfile {
  created_at: string;
  subscription_status: SubscriptionStatus;
  current_period_end: string | null;
}

export interface Access {
  allowed: boolean;
  daysUsed: number;
  daysLeft: number;
  reason: "subscribed" | "trial" | "trial_expired" | "past_due";
}
