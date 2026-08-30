/**
 * The parts of reminder delivery that are genuinely the same everywhere.
 *
 * Extracted 2026-08-29 from Paper Trail (29), House Ledger (26) and FirstDay
 * (9), and the scope is deliberately much narrower than
 * `extract-engine.ts`'s. That difference is the finding, so it is worth
 * recording rather than smoothing over.
 *
 * The extraction engine was justified by 250 byte-identical lines out of 400:
 * the whole runtime repeated and only vocabulary varied. Reminder delivery
 * measured very differently. Comparing the three senders:
 *
 * - `json`, `localParts` and `entitled` are byte-identical. About 55 lines.
 * - The `Deno.serve` preamble differs by 4 lines.
 * - Everything else -- the query, the email copy, the send log write -- is
 *   genuinely per app, because the three are querying different tables with
 *   different notions of what "due" means. Paper Trail consumes an alert.
 *   House Ledger's tasks RECUR, so its log is keyed by occurrence. FirstDay
 *   must filter on `confirmed`, which is its entire product rule.
 *
 * So only the identical part moves. Forcing a `createReminderSender(config)`
 * to cover the rest would have meant a config that was really three query
 * builders and three copywriters wearing one type, which is the wrong
 * abstraction that `ARCHITECTURE.md` warns extraction-too-early produces.
 *
 * What is here is small, pure, and subtle enough that three copies is a real
 * liability: `localParts` has a DST edge and an hour-24 normalisation, and
 * `entitled` has to agree with the billing package or the server and the
 * client disagree about who is a customer.
 *
 * ## Copying, not importing
 *
 * Same as the other functions in this directory. Edge Functions are Deno,
 * deploy per project, and this repository is private, so a raw URL import
 * would need a token. Copy to `supabase/functions/_shared/` and check for
 * drift with:
 *
 *   diff supabase/functions/_shared/reminder-runtime.ts \
 *        node_modules/@carrier/platform/functions/reminder-runtime.ts
 */

export const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

/**
 * Must match `DEFAULT_TRIAL_DAYS` in the billing package.
 *
 * An argument rather than a constant at the call site, because the whole point
 * of moving it here is that three hardcoded copies is how the server and the
 * client end up disagreeing about who is entitled.
 */
export const DEFAULT_TRIAL_DAYS = 14;

export interface EntitlementFields {
  created_at: string;
  subscription_status: string;
  current_period_end: string | null;
}

/**
 * The user's own wall clock.
 *
 * `Intl` is the only correct way to do this: it knows a zone's offset moves
 * twice a year, which arithmetic on a stored offset does not. An unknown zone
 * name throws, and every caller treats that as "skip this user" rather than
 * guessing, because guessing means mailing someone at 3am.
 *
 * ## Two DST behaviours, tested rather than assumed
 *
 * Verified against America/Chicago in 2026:
 *
 * - **Fall-back.** Local hour 1 occurs twice, so an hourly matcher fires twice
 *   on one local date. Every caller must therefore have a database-level
 *   at-most-once guard; none may rely on being called once.
 * - **Spring-forward.** Local hour 2 does not exist, so a user who chose 2am
 *   gets no run that day. Callers must query with `<=` rather than `=` so the
 *   work goes out late rather than never, and should not offer 2am as a choice.
 */
export function localParts(
  tz: string,
  now: Date,
): { date: string; hour: number } {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    hour12: false,
  });
  const parts = Object.fromEntries(
    fmt.formatToParts(now).map((p) => [p.type, p.value]),
  );
  // en-CA gives ISO-ordered date parts, and hour "24" at midnight in some
  // runtimes, which has to be normalised or midnight never matches hour 0.
  const hour = parseInt(parts.hour, 10) % 24;
  return { date: `${parts.year}-${parts.month}-${parts.day}`, hour };
}

/**
 * Mirrors `evaluateAccess()` in `@carrier/platform/billing`.
 *
 * An "active" row whose paid period has lapsed is not entitled: the RevenueCat
 * webhook deliberately leaves the status alone between CANCELLATION and
 * EXPIRATION so the paid-for remainder is honoured, and the date is the
 * backstop if an EXPIRATION event is ever dropped.
 */
export function entitled(
  p: EntitlementFields,
  now: Date,
  trialDays = DEFAULT_TRIAL_DAYS,
): boolean {
  const periodEnd = p.current_period_end
    ? new Date(p.current_period_end).getTime()
    : null;
  if (
    p.subscription_status === "active" &&
    (periodEnd === null || periodEnd > now.getTime())
  ) {
    return true;
  }
  const daysUsed = Math.floor(
    (now.getTime() - new Date(p.created_at).getTime()) / 86_400_000,
  );
  return daysUsed < trialDays;
}
