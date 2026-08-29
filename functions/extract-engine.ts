/**
 * The Wave B document-extraction engine.
 *
 * Extracted 2026-08-29 from Paper Trail (29), House Ledger (26) and Doorstop
 * (12), at the third instance, which is what `ARCHITECTURE.md` asks for. The
 * evidence rather than the intuition: the 250 lines from `const json =` to the
 * end of the handler were **byte-identical across all three apps**, verified by
 * diff, and everything that differed was vocabulary.
 *
 * So the seam is vocabulary in, handler out. What an app supplies is data:
 * which document kinds exist, what an expiry means in its world, what belongs
 * in `fields`, and the prose that teaches the model its domain. What it gets
 * back is the whole runtime: entitlement, storage download, base64 framing,
 * message assembly, the tool call, the confidence clamp, the status
 * transitions, and the failure path.
 *
 * ## Two confidence axes, not one
 *
 * Paper Trail's `expiry_confidence` answers "was this READ correctly". Doorstop
 * needed something different: "is this JUDGEMENT mine to make at all". A
 * perfectly legible receipt does not say whether a new roof bettered the
 * property or restored it, and that question is worth thousands of dollars
 * either way.
 *
 * Generalising only the first axis would have produced a platform that looked
 * right for two apps and was wrong for the third. So the second axis is a
 * first-class part of the vocabulary: `refusals` declares boolean fields the
 * model must FLAG rather than answer, and the engine renders the standing
 * instruction that goes with them. An app with nothing to refuse passes none.
 *
 * ## Why a copied file rather than an import
 *
 * Supabase Edge Functions are Deno and deploy per project from each app's own
 * `supabase/functions/` directory, and this repository is private, so a raw
 * URL import would need a token. The established convention here, already used
 * by `delete-account.ts` and `revenuecat-webhook.ts`, is that this directory
 * holds **canonical copies**. Copy this file to the app's
 * `supabase/functions/_shared/extract-engine.ts` and treat this one as the
 * source of truth when they diverge.
 *
 * The improvement over those two: because the app file now holds only
 * vocabulary, re-copying this file cannot clobber an app-specific edit. There
 * are no app-specific edits.
 */
import Anthropic from "npm:@anthropic-ai/sdk@0.120.0";
import { createClient } from "npm:@supabase/supabase-js@2";

/** A boolean field the model must raise as a QUESTION and never answer. */
export interface Refusal {
  /** Field name in `fields`, e.g. `capital_question`. */
  field: string;
  /** The prose that teaches the model when to raise it and why not to decide. */
  guidance: string;
}

export interface ExtractorVocabulary {
  /** Document kinds this app recognises. Always include a catch-all. */
  kinds: readonly string[];
  /**
   * What an expiry date MEANS in this app's world, excluding "none", which the
   * engine always appends. Paper Trail: lapse/renewal/return_window. House
   * Ledger swaps in service_due; Doorstop, lease_end.
   */
  expiryKinds: readonly string[];
  /** One line per kind, teaching what to pull out of it. */
  kindGuidance: string;
  /** The sentence defining each expiry kind, in the app's own words. */
  expiryKindSentence: string;
  /** How to write a title someone will recognise later, with an example. */
  titleGuidance: string;
  /** Anything else the domain needs. Doorstop's Schedule E block lives here. */
  extraGuidance?: string;
  /** JSON-schema properties for `fields`, plus the required list. */
  fields: {
    properties: Record<string, unknown>;
    required: readonly string[];
  };
  /** Judgements the model must flag rather than make. Usually empty. */
  refusals?: readonly Refusal[];
}

export interface ExtractorConfig {
  vocabulary: ExtractorVocabulary;
  /**
   * Must match `DEFAULT_TRIAL_DAYS` in the billing package, or the client and
   * the server disagree about who is entitled.
   *
   * This was the one piece of drift the first extraction did not fix: both
   * shipped Edge Functions still hardcode their own copy. Here it is an
   * argument, so at least the new rail cannot drift silently.
   */
  trialDays?: number;
  /** Storage bucket holding the scans. Every app so far uses `scans`. */
  bucket?: string;
  /** Anthropic model id. */
  model?: string;
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

/** Mime types the vision model accepts. PDFs take the document block instead. */
const IMAGE_TYPES = ["image/jpeg", "image/png", "image/gif", "image/webp"];

function mimeFromPath(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase();
  if (ext === "png") return "image/png";
  if (ext === "webp") return "image/webp";
  if (ext === "heic") return "image/heic";
  if (ext === "pdf") return "application/pdf";
  return "image/jpeg";
}

/** Strip nulls so they land as absent keys in `fields` rather than null values. */
function compactFields(fields: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(fields)) {
    if (v === null || v === undefined) continue;
    if (Array.isArray(v) && v.length === 0) continue;
    out[k] = v;
  }
  return out;
}

/**
 * The system prompt.
 *
 * The confidence paragraph is NOT parameterised, deliberately. The 0.75 floor,
 * the instruction not to inflate, and the reasoning that asking is cheap while
 * a confident wrong date is unrecoverable are the same argument in every app,
 * and an app that wanted to soften them would be an app that had misunderstood
 * what this engine is for.
 */
function buildSystem(v: ExtractorVocabulary): string {
  const refusalBlock = (v.refusals ?? [])
    .map(
      (r) =>
        `${r.guidance}\n\nYou must NOT decide that question. Set ${r.field} to true, put your reason in expiry_reasoning, and let the app ask the person. Being over-inclusive is cheap and being wrong is not, so flag when in doubt.`,
    )
    .join("\n\n");

  return `You read a photographed or forwarded document and extract the facts a person would need later, when the document itself is not to hand.

Decide which kind of document it is, then extract accordingly:

${v.kindGuidance}

The expiry date is the most important field you produce, because the app schedules a real reminder from it and a wrong date costs the user money or trust. Treat it accordingly:

- Give expiry_confidence honestly, as a number from 0 to 1. It is the probability that a careful person reading this same document would agree with your date. A date printed in full is high. A date you computed from a purchase date plus a stated term is high. A date you inferred from a typical term that the document does not state is LOW, below 0.5, however reasonable the inference. Never inflate it: the app asks the user to confirm anything below 0.75, which is a cheap and correct outcome, whereas a confident wrong date is not recoverable.
- If there is no expiry, set expires_on to null and expiry_kind to "none". Do not manufacture one.
- ${v.expiryKindSentence}

Anything you read but cannot place goes in unplaced, with a plain reason. Be particularly careful with exclusions, conditions and anything that limits a claim: losing one of those silently is the worst thing this app can do to someone, so an exclusion you cannot fit into a field belongs in unplaced rather than dropped.

${v.titleGuidance}
${v.extraGuidance ? `\n${v.extraGuidance}\n` : ""}${refusalBlock ? `\n${refusalBlock}\n` : ""}
Amounts are numbers without currency symbols or thousands separators. Dates are ISO, YYYY-MM-DD. If a year is genuinely ambiguous, leave the field null and say why in unplaced rather than guessing.`;
}

function buildTool(v: ExtractorVocabulary) {
  return {
    name: "record_document",
    description:
      "Record the facts extracted from the document, and anything that could not be placed.",
    input_schema: {
      type: "object",
      additionalProperties: false,
      properties: {
        kind: { type: "string", enum: [...v.kinds] },
        title: { type: "string" },
        vendor: { type: ["string", "null"] },
        amount: { type: ["number", "null"] },
        currency: { type: ["string", "null"] },
        document_date: { type: ["string", "null"] },
        expires_on: { type: ["string", "null"] },
        expiry_kind: {
          type: ["string", "null"],
          enum: [...v.expiryKinds, "none", null],
        },
        expiry_confidence: { type: ["number", "null"] },
        /** Why the date is what it is. Shown to the user beside the date. */
        expiry_reasoning: { type: ["string", "null"] },
        fields: {
          type: "object",
          additionalProperties: false,
          properties: v.fields.properties,
          required: [...v.fields.required],
        },
        unplaced: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              text: { type: "string" },
              reason: { type: "string" },
            },
            required: ["text", "reason"],
          },
        },
      },
      required: [
        "kind", "title", "vendor", "amount", "currency", "document_date",
        "expires_on", "expiry_kind", "expiry_confidence", "expiry_reasoning",
        "fields", "unplaced",
      ],
    },
    strict: true,
  };
}

/**
 * Build the request handler. Pass the result straight to `Deno.serve`.
 */
export function createExtractor(config: ExtractorConfig) {
  const {
    vocabulary,
    trialDays = 14,
    bucket = "scans",
    model = "claude-opus-5",
  } = config;

  const SYSTEM = buildSystem(vocabulary);
  const EXTRACT_TOOL = buildTool(vocabulary);

  return async (req: Request): Promise<Response> => {
    if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

    const authHeader = req.headers.get("Authorization");
    if (!authHeader) return json({ error: "Not signed in" }, 401);

    const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
    if (!apiKey) return json({ error: "This is not configured yet" }, 500);

    let documentId: string;
    try {
      const body = await req.json();
      documentId = body?.document_id;
      if (!documentId) throw new Error("missing");
    } catch {
      return json({ error: "Which document?" }, 400);
    }

    const asUser = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_ANON_KEY")!,
      { global: { headers: { Authorization: authHeader } } },
    );

    const {
      data: { user },
    } = await asUser.auth.getUser();
    if (!user) return json({ error: "Not signed in" }, 401);

    const { data: profile } = await asUser
      .from("profiles")
      .select("subscription_status, current_period_end, created_at")
      .eq("id", user.id)
      .maybeSingle();
    if (!profile) return json({ error: "Profile not found" }, 404);

    // Mirrors evaluateAccess() in @carrier/platform/billing. An "active" row
    // whose paid period has lapsed is not entitled: the webhook leaves the
    // status alone between CANCELLATION and EXPIRATION on purpose.
    const periodEnd = profile.current_period_end
      ? new Date(profile.current_period_end).getTime()
      : null;
    const subscribed =
      profile.subscription_status === "active" &&
      (periodEnd === null || periodEnd > Date.now());
    const daysUsed = Math.floor(
      (Date.now() - new Date(profile.created_at).getTime()) / 86_400_000,
    );
    if (!subscribed && daysUsed >= trialDays) {
      return json({ error: "Your trial has ended." }, 402);
    }

    // RLS scopes this to the caller's own rows, so a document_id belonging to
    // someone else simply is not found.
    const { data: doc } = await asUser
      .from("documents")
      .select("id, image_path, source_text, status")
      .eq("id", documentId)
      .maybeSingle();
    if (!doc) return json({ error: "Document not found" }, 404);

    if (!doc.image_path && !doc.source_text) {
      return json({ error: "There is nothing to read on this one." }, 400);
    }

    await asUser
      .from("documents")
      .update({ status: "extracting", failure_reason: null })
      .eq("id", doc.id);

    const fail = async (reason: string, status: number) => {
      await asUser
        .from("documents")
        .update({ status: "failed", failure_reason: reason })
        .eq("id", doc.id);
      return json({ error: reason }, status);
    };

    try {
      // Build the message content. An image goes as a vision block; a forwarded
      // email goes as text. A document can legitimately have both -- a scan with
      // the covering email -- and both are worth sending.
      const content: unknown[] = [];

      if (doc.image_path) {
        // Service role to read the object: the caller's own token would work
        // through the storage policy, but downloading inside the function keeps
        // the bytes off the device's round trip entirely.
        const admin = createClient(
          Deno.env.get("SUPABASE_URL")!,
          Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
          { auth: { persistSession: false } },
        );
        const { data: blob, error: dlError } = await admin.storage
          .from(bucket)
          .download(doc.image_path);
        if (dlError || !blob) return await fail("Could not open that scan.", 502);

        const bytes = new Uint8Array(await blob.arrayBuffer());
        let binary = "";
        for (let i = 0; i < bytes.length; i++) {
          binary += String.fromCharCode(bytes[i]);
        }
        const base64 = btoa(binary);
        const mime = mimeFromPath(doc.image_path);

        content.push(
          mime === "application/pdf"
            ? {
                type: "document",
                source: { type: "base64", media_type: mime, data: base64 },
              }
            : {
                type: "image",
                source: {
                  type: "base64",
                  // HEIC is accepted by the bucket because that is what iPhones
                  // produce, but the API does not take it. The client converts
                  // on capture; this is the backstop for anything that slips by.
                  media_type: IMAGE_TYPES.includes(mime) ? mime : "image/jpeg",
                  data: base64,
                },
              },
        );
      }

      if (doc.source_text) {
        content.push({
          type: "text",
          // Truncated defensively. A document past this length is a manual, and
          // the fields worth extracting are near the front.
          text: `Document text:\n\n${doc.source_text.slice(0, 40_000)}`,
        });
      }

      content.push({
        type: "text",
        // The model has no clock. Without today's date it cannot tell a warranty
        // that ended last year from one ending next year, and both are plausible
        // readings of a two-digit year.
        text: `Today's date is ${new Date().toISOString().slice(0, 10)}.`,
      });

      const client = new Anthropic({ apiKey });
      const response = await client.messages.create({
        model,
        max_tokens: 8000,
        thinking: { type: "adaptive" },
        system: SYSTEM,
        tools: [EXTRACT_TOOL as never],
        tool_choice: { type: "tool", name: "record_document" },
        messages: [{ role: "user", content: content as never }],
      });

      const block = response.content.find(
        (b) => b.type === "tool_use" && b.name === "record_document",
      );
      if (!block || block.type !== "tool_use") {
        return await fail("Could not read that document.", 502);
      }

      const out = block.input as {
        kind: string;
        title: string;
        vendor: string | null;
        amount: number | null;
        currency: string | null;
        document_date: string | null;
        expires_on: string | null;
        expiry_kind: string | null;
        expiry_confidence: number | null;
        expiry_reasoning: string | null;
        fields: Record<string, unknown>;
        unplaced: unknown[];
      };

      // Clamp rather than trust. The column has a check constraint and a value
      // outside 0-1 would reject the whole insert, losing a good extraction over
      // one malformed number.
      const confidence =
        typeof out.expiry_confidence === "number"
          ? Math.min(1, Math.max(0, out.expiry_confidence))
          : null;

      const { error: insertError } = await asUser.from("records").insert({
        user_id: user.id,
        document_id: doc.id,
        kind: out.kind,
        title: out.title,
        vendor: out.vendor,
        amount: out.amount,
        currency: out.currency,
        document_date: out.document_date,
        expires_on: out.expires_on,
        expiry_kind: out.expiry_kind,
        expiry_confidence: confidence,
        fields: compactFields(out.fields ?? {}),
        unplaced: Array.isArray(out.unplaced) ? out.unplaced : [],
        // The reasoning is shown next to the date so the user can judge it
        // rather than take it on faith. It is the basis of every app's version
        // of the "this is a nudge, not a verdict" note.
        notes: out.expiry_reasoning,
      });
      if (insertError) return await fail(insertError.message, 500);

      await asUser.from("documents").update({ status: "done" }).eq("id", doc.id);

      return json({ ok: true });
    } catch (e) {
      const message =
        e instanceof Error ? e.message : "Could not read that document.";
      return await fail(message, 500);
    }
  };
}
