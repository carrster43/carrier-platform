/**
 * RevenueCat -> Flare entitlement sync.
 *
 * This is the ONLY writer of profiles.subscription_status. The client used to
 * write it directly (lib/purchases.ts syncEntitlement), which meant the paid
 * tier was self-serve: anyone could PATCH their own row to "active". Migration
 * 0002 revoked that column from the client, and this function takes over.
 *
 * It runs with the service-role key, so it bypasses RLS and the column grants.
 * That key never leaves the function. Deploy with --no-verify-jwt: the caller
 * is RevenueCat, not a signed-in user, so it is authenticated by the shared
 * secret below instead of a Supabase JWT.
 *
 * Configure in RevenueCat: Integrations -> Webhooks, URL
 *   https://<project>.supabase.co/functions/v1/revenuecat-webhook
 * with the Authorization header set to the same value as REVENUECAT_WEBHOOK_SECRET.
 */
import { createClient } from "npm:@supabase/supabase-js@2";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

/** The RevenueCat event types we act on. Anything else is acknowledged and ignored. */
type EventType =
  | "INITIAL_PURCHASE"
  | "RENEWAL"
  | "PRODUCT_CHANGE"
  | "UNCANCELLATION"
  | "CANCELLATION"
  | "EXPIRATION"
  | "BILLING_ISSUE"
  | "SUBSCRIPTION_PAUSED"
  | "TRANSFER";

interface RcEvent {
  type: EventType | string;
  app_user_id: string;
  /** Epoch ms when the current entitlement lapses. Null for lifetime purchases. */
  expiration_at_ms: number | null;
  /** Present on CANCELLATION: "unsubscribe" | "billing_error" | "customer_support" | ... */
  cancel_reason?: string;
}

/** The values profiles.subscription_status is allowed to hold. */
type Status = "trialing" | "active" | "past_due" | "canceled";

/**
 * Map a RevenueCat event to the subscription_status we store.
 *
 * Returning null means "acknowledge the webhook but leave the row alone".
 *
 * The load-bearing case is CANCELLATION. RevenueCat fires it the moment
 * someone switches off auto-renew, but their access legitimately runs to
 * expiration_at_ms. Writing "canceled" there would deny time they already paid
 * for, so we leave the status alone and let it lapse on EXPIRATION.
 *
 * That would leave a hole if an EXPIRATION webhook were ever dropped, so it is
 * not the only guard: this function always writes current_period_end, and
 * evaluateAccess() in lib/access.ts treats an "active" row whose period has
 * already ended as expired. The timestamp is the backstop, the event is the
 * fast path, and neither depends on the other.
 */
function statusForEvent(event: RcEvent): Status | null {
  switch (event.type) {
    case "INITIAL_PURCHASE":
    case "RENEWAL":
    case "UNCANCELLATION":
    case "PRODUCT_CHANGE":
      return "active";

    // Payment failed. Distinct from a trial running out: this needs a billing
    // fix, not a second purchase, and lib/access.ts says so in the copy.
    case "BILLING_ISSUE":
      return "past_due";

    // Auto-renew off. Access continues to expiration_at_ms, which this event
    // still carries, so record the date and change nothing else.
    case "CANCELLATION":
      return event.cancel_reason === "billing_error" ? "past_due" : null;

    case "EXPIRATION":
    case "SUBSCRIPTION_PAUSED":
      return "canceled";

    // TRANSFER moves an entitlement between app_user_ids. Acting on it here
    // would write the wrong row, since the event names only one of the two.
    // Unknown types are ignored rather than guessed at.
    default:
      return null;
  }
}

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const secret = Deno.env.get("REVENUECAT_WEBHOOK_SECRET");
  if (!secret) return json({ error: "Webhook is not configured" }, 500);

  // A wrong secret is a rejected caller, not a retryable failure — 401 tells
  // RevenueCat to stop retrying and surface the misconfiguration.
  if (req.headers.get("Authorization") !== secret) {
    return json({ error: "Unauthorized" }, 401);
  }

  let event: RcEvent;
  try {
    const body = await req.json();
    event = body?.event;
    if (!event?.app_user_id || !event?.type) throw new Error("malformed");
  } catch {
    return json({ error: "Malformed event" }, 400);
  }

  const status = statusForEvent(event);
  const periodEnd = event.expiration_at_ms
    ? new Date(event.expiration_at_ms).toISOString()
    : null;

  // A CANCELLATION deliberately changes no status, but it is the event that
  // tells us when access actually ends. Record that date even though the
  // status stands, because evaluateAccess() leans on it as the backstop.
  const patch: Record<string, unknown> = {};
  if (status !== null) {
    patch.subscription_status = status;
    patch.current_period_end = periodEnd;
  } else if (event.type === "CANCELLATION") {
    patch.current_period_end = periodEnd;
  }

  // Nothing to write. 200 so RevenueCat does not retry it forever.
  if (Object.keys(patch).length === 0) {
    return json({ ok: true, ignored: event.type });
  }

  // Service role: bypasses RLS and the 0002 column grants. This is the whole
  // reason entitlement is safe now — the key exists only here.
  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    { auth: { persistSession: false } },
  );

  // app_user_id is the Supabase user id: lib/purchases.ts configures RevenueCat
  // with appUserID = session.user.id, so no extra mapping table is needed.
  const { error } = await supabase
    .from("profiles")
    .update(patch)
    .eq("id", event.app_user_id);

  // 500 so RevenueCat retries — a dropped write here silently strips access
  // from someone who paid.
  if (error) return json({ error: error.message }, 500);

  return json({ ok: true, applied: patch });
});
