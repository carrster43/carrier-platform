import Purchases, { type CustomerInfo } from "react-native-purchases";
import { Platform } from "react-native";
import type { SupabaseClient } from "@supabase/supabase-js";

export interface PurchasesConfig {
  /** The entitlement identifier configured in RevenueCat, per app. */
  entitlement: string;
  iosKey?: string;
  androidKey?: string;
}

export function configurePurchases(
  appUserId: string,
  config: PurchasesConfig,
): boolean {
  const key = Platform.OS === "ios" ? config.iosKey : config.androidKey;

  // Without a key the app still runs; entitlement simply never turns on, which
  // is the safe direction to fail.
  if (!key) return false;

  Purchases.configure({ apiKey: key, appUserID: appUserId });
  return true;
}

export function isEntitled(info: CustomerInfo, entitlement: string): boolean {
  return typeof info.entitlements.active[entitlement] !== "undefined";
}

/**
 * Wait for the RevenueCat webhook to land.
 *
 * The client cannot write entitlement. Every app in the portfolio revokes
 * `profiles.subscription_status` from the authenticated role, because a
 * client-writable entitlement column means anyone can grant themselves paid
 * model access with a single PATCH. The webhook function is the only writer,
 * so after a purchase there is a short gap between RevenueCat confirming the
 * sale to the device and the row reflecting it.
 *
 * Polls until the row says active, then gives up. Returning false is not a
 * failed purchase — RevenueCat already has their money and the entitlement.
 * It means the mirror is late, and the caller should say so rather than
 * implying the payment did not go through.
 */
export async function waitForEntitlement(
  supabase: SupabaseClient,
  userId: string,
  { attempts = 6, intervalMs = 1500 } = {},
): Promise<boolean> {
  for (let i = 0; i < attempts; i++) {
    const { data } = await supabase
      .from("profiles")
      .select("subscription_status")
      .eq("id", userId)
      .maybeSingle();

    if (data?.subscription_status === "active") return true;
    await new Promise<void>((resolve) => setTimeout(() => resolve(), intervalMs));
  }
  return false;
}
