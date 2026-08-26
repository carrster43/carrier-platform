import { type CustomerInfo } from "react-native-purchases";
import type { SupabaseClient } from "@supabase/supabase-js";
export interface PurchasesConfig {
    /** The entitlement identifier configured in RevenueCat, per app. */
    entitlement: string;
    iosKey?: string;
    androidKey?: string;
}
export declare function configurePurchases(appUserId: string, config: PurchasesConfig): boolean;
export declare function isEntitled(info: CustomerInfo, entitlement: string): boolean;
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
export declare function waitForEntitlement(supabase: SupabaseClient, userId: string, { attempts, intervalMs }?: {
    attempts?: number | undefined;
    intervalMs?: number | undefined;
}): Promise<boolean>;
