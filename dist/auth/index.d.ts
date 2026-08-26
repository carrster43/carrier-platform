import "react-native-url-polyfill/auto";
import { type SupabaseClient } from "@supabase/supabase-js";
/**
 * Build the app's Supabase client.
 *
 * The url and key are arguments rather than being read from
 * `Constants.expoConfig.extra` inside here, which is what both apps did before
 * extraction. Reading them in the shared layer would silently require every
 * future app to name those two config keys identically, which is a coupling
 * nothing declares and nothing checks. Passing them keeps the contract visible
 * at the call site.
 */
export declare function createSupabaseClient(url: string, anonKey: string): SupabaseClient;
