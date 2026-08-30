# @carrier/platform

Shared auth and billing for the Carrier app portfolio. Versioned packages, not
an app. See `carrier-ventures/documents/ARCHITECTURE.md`.

## What is in here, and what is deliberately not

Extracted after Flare (entry 1) and Perimeter (entry 3), from what was
measurably duplicated between them:

| Module | Was | Now |
|---|---|---|
| `auth` | `lib/supabase.ts`, byte-identical in both | `createSupabaseClient(url, key)` |
| `billing/access` | `lib/access.ts`, byte-identical in both | `evaluateAccess(profile, { trialDays })` |
| `billing/purchases` | `lib/purchases.ts`, 2 lines apart | config passed in, no module-level constant |
| `functions/` | four Edge Functions | canonical copies |

**Left in the apps on purpose:**

- **`lib/theme.ts`.** Diverged by 17 lines the first time it was reused. Two
  apps are not enough to know which parts of a design system are shared and
  which are the product, and a wrong guess here is expensive to undo.
- **`components/Paywall.tsx`.** The mechanism is shared but every differing
  line is sales copy, and the copy is the product. A candidate for extraction
  once a third app says the same thing a third way.
- **Each app's medical or domain discipline.** Flare's "co-occurrence, never
  causation" and Perimeter's "never stage, never attribute" look alike and are
  not. They are enforced in prompts, tool schemas and on-screen copy at once,
  they differ per app by design, and sharing them would be the exact wrong
  lesson from noticing they rhyme.

`ARCHITECTURE.md` calls for extraction at app 3, from what repeated three
times. This was done at app 2, on instruction. The scope above is narrower
than the document's eventual package list for that reason: everything here is
either byte-identical across both apps or differs only in a value that became
an argument. Nothing was generalised on the strength of a single example.

Not yet extracted, because no app has needed them twice: analytics,
design-system, doc-extraction, reminders, multi-tenant-branding.

## Consuming it

Pinned by git tag, so one app upgrading cannot break another:

```json
"@carrier/platform": "github:carrster43/carrier-platform#v0.1.0"
```

`dist/` is committed. That is deliberate and not laziness: npm 11 defers a git
dependency's `prepare` script pending approval, and an install that skips it
produces a package with no `dist` **and no error**. A CI runner, a fresh
machine, or anyone with `ignore-scripts=true` would get a silently empty
dependency. Committing the build output makes installation script-independent.

`prepare` is kept so a working copy of this repo stays buildable, so the two
can drift. The release ritual exists to stop that:

```
npm run build && git add -A && git commit && git tag vX.Y.Z && git push --tags
```

Build before tagging, always. Moving to GitHub Packages later removes the need
for committed output and changes only the dependency line.

## The BillingProfile boundary

`evaluateAccess` takes a `BillingProfile` of exactly three fields, not an app's
`Profile`. Flare's carries `condition` and Perimeter's carries `cycle_pattern`,
and a shared package that knows about either has stopped being a platform.
Both app types satisfy it structurally, so neither had to change to comply.

## The Edge Functions

`functions/` holds canonical copies rather than a dependency, because Supabase
Edge Functions are Deno and are deployed per project from each app's own
`supabase/functions/` directory, and this repository is private, so a raw URL
import would need a token. Copy them in; treat this directory as the source of
truth when they diverge.

`delete-account.ts` and `revenuecat-webhook.ts` are copy-and-edit: each app's
version carries its own header and its own `TRIAL_DAYS`. That duplication is the
one piece of drift the first extraction did not fix.

**`extract-engine.ts` is different, and better.** It exports `createExtractor(config)`
rather than a handler, so the copied file is identical in every app and the app's
own function holds only vocabulary. Re-copying it cannot clobber an app-specific
edit, because there are no app-specific edits. `trialDays` is an argument here,
so the new rail cannot drift the way the older two did.

### Reminder delivery, and why it extracted much less

Added at **v0.3.0** from Paper Trail, House Ledger and FirstDay. The scope is
deliberately far narrower than the extraction engine's, and the difference is
the finding rather than an oversight.

The engine was justified by 250 byte-identical lines out of 400: the whole
runtime repeated and only vocabulary varied. Reminder delivery measured
differently. `json`, `localParts` and `entitled` are byte-identical, about 55
lines, and the `Deno.serve` preamble differs by four. **Everything else is
genuinely per app**, because the three query different tables with different
notions of "due": Paper Trail consumes an alert, House Ledger's tasks recur so
its log is keyed by occurrence, and FirstDay must filter on `confirmed`, which
is its whole product rule.

So only the identical part moved. A `createReminderSender(config)` covering the
rest would have been three query builders and three copywriters sharing one
type, which is exactly the wrong abstraction `ARCHITECTURE.md` warns that
extracting too early produces.

What did move is small, pure and subtle enough that three copies is a real
liability. `localParts` carries a DST edge and an hour-24 normalisation;
`entitled` has to agree with the billing package or the server and the client
disagree about who is a customer.

### Multi-user RLS: considered at three instances, and NOT extracted

Wave C produced three multi-user apps — PillProof (5), Handoff (8) and Relay (6)
— so `ARCHITECTURE.md`'s rule of three applies. It was measured the same way the
other two extractions were, and it came back with a different answer.

| candidate | identical lines | outcome |
|---|---|---|
| `extract-engine` | 250 of 400 | extracted as a factory (v0.2.0) |
| `reminder-runtime` | 55 of 330 | extracted as helpers (v0.3.0) |
| multi-user RLS | **~3** | **not extracted** |

What actually repeats is one line of SQL with three names substituted:

```sql
create or replace function public.my_<group>_ids()
returns setof uuid language sql stable security definer set search_path = public as $$
  select <group>_id from <membership table> where user_id = auth.uid();
$$;
```

Everything around it diverges, and not incidentally:

- **The role model is different in all three.** PillProof has
  `owner/carer/viewer`. Relay has `owner/family/helper`, where a helper is a paid
  carer who sees everything except the money. **Handoff has no roles at all**,
  because an owner in an adversarial pair is a lever: whoever signed up first
  could delete the shared record before a hearing.
- **The second helper is unrelated in each app**: `my_device_recipient`,
  `my_party_id`, `my_family_circle_ids`.
- **The vocabulary is the product.** Households, arrangements and circles are
  not the same noun wearing different labels, and forcing them onto shared table
  names to enable an extraction would make every app slightly wrong to read.

**What repeats is a technique, not an artefact**, and a package cannot hold a
technique. Extracting it would mean either a code generator or a false
uniformity, and both are the wrong-abstraction failure `ARCHITECTURE.md` warns
that extracting too early produces — reached this time by extracting too eagerly
rather than too soon.

The knowledge is real and belongs written down, so it is here rather than in
code:

1. **Policy recursion is the trap.** A policy on the membership table that
   queries the membership table re-enters policy evaluation and loops forever.
   `SECURITY DEFINER` breaks the cycle; `STABLE` makes Postgres cache the result
   per statement instead of per row.
2. **The creator needs their membership row from a trigger**, not the client.
   Membership tables have `insert` revoked (a client that can write them can add
   itself to any group whose id it can guess), so without an
   `after insert on <group>` trigger the creator is locked out of the thing they
   just made. Both PillProof and Relay needed this.
3. **Author links are `on delete set null`, never `cascade`, on anything
   shared.** Cascading lets one member erase their half of a shared history by
   closing their own account. Stamp the author's name at write time instead:
   it survives, and for a record that may be read later it is more correct
   anyway.
4. **Codes are `gen_random_bytes`, not `random()`.** `random()` is a seeded PRNG
   whose output is predictable from earlier output, and these grant access to
   somebody's medical or legal record.

### Checking a copy for drift

`functions/` ships inside the package as of v0.2.1, so a consuming app can prove
its copy is current without cloning this repo:

```bash
diff supabase/functions/_shared/extract-engine.ts \
     node_modules/@carrier/platform/functions/extract-engine.ts
```

Silent divergence is the one real cost of a copy-based rail, and that one line
removes it. Worth running before touching any extraction behaviour.

### The extraction engine, and the evidence for it

Added at **v0.2.0**, extracted from Paper Trail (29), House Ledger (26) and
Doorstop (12) at the third instance, which is what `ARCHITECTURE.md` asks for.

The justification was measured rather than assumed: the 250 lines from
`const json =` to the end of the handler were **byte-identical across all three
apps**, verified by diff. Everything that differed was vocabulary. The refactor
was then checked by generating each app's system prompt and tool schema from its
new config and diffing against the hand-written originals: **Paper Trail and
House Ledger reproduce byte-for-byte**, and Doorstop differs by one deliberate
improvement, the engine naming the refused field explicitly where the original
said only "flag it".

The seam is data, not behaviour. An app supplies strings and a JSON-schema
fragment; it cannot alter control flow. Two things are deliberately not
configurable: the 0.75 confidence floor and the instruction never to inflate it.
An app wanting to soften those has misunderstood what the engine is for.

**Two confidence axes.** Paper Trail's `expiry_confidence` answers "was this READ
correctly". Doorstop needed "is this JUDGEMENT mine to make at all" -- a legible
receipt still does not say whether a new roof bettered or restored a property.
Generalising only the first axis would have produced a platform that looked right
for two apps and was wrong for the third, so `refusals` is a first-class part of
the vocabulary. Apps with nothing to refuse pass none.
