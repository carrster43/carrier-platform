import "react-native-url-polyfill/auto";
import { createClient } from "@supabase/supabase-js";
import * as SecureStore from "expo-secure-store";
import { Platform } from "react-native";
/**
 * Sessions live in the device keychain rather than a cookie. SecureStore has a
 * 2048-byte limit per value and is unavailable on web, so fall back cleanly
 * instead of throwing during development.
 */
const secureStorage = {
    getItem: (key) => SecureStore.getItemAsync(key),
    setItem: (key, value) => SecureStore.setItemAsync(key, value),
    removeItem: (key) => SecureStore.deleteItemAsync(key),
};
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
export function createSupabaseClient(url, anonKey) {
    return createClient(url, anonKey, {
        auth: {
            storage: Platform.OS === "web" ? undefined : secureStorage,
            autoRefreshToken: true,
            persistSession: true,
            // There is no URL bar to read a callback from in a native app.
            detectSessionInUrl: false,
        },
    });
}
