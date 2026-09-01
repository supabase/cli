# 0021. `ProjectConfig` normalizers predict post-push state, not a verbatim projection

**Status**: accepted
**Date**: 2026-08-27

## Problem Statement

CLI-2230 (PR supabase/cli#6339) shipped two normalizers into `ProjectConfig`:
`fromConfigDocument` (a local `CliConfig`/`EffectiveConfig` document → the hosted subset) and
`fromApiProjectConfig` (a Management API v2 project-config response → the hosted subset). Both feed
the sparse subtraction core from ADR 0018 — CLI-2156's `config diff` and Studio's drift page compare
one side's `ProjectConfig` against the other's structurally, by simple value comparison.

Across 29 codex review rounds, both normalizers accumulated a large body of canonicalization logic
that a literal, verbatim projection of either input would not have: comma-joined arrays re-split,
durations and byte sizes re-quantized to the units the legacy push pipeline actually produces,
uint clamps, an SMS-provider precedence rule, disabled-sentinel pruning of gated siblings, and typed
range/discriminator/digest-shape validation on the API side. Every one of these was added because a
_verbatim_ projection of one side's input fabricates phantom drift against the other side's
`ProjectConfig` for a state that a real `config push` would never actually produce or retain — e.g. a
document that enables two SMS providers, or an API response reporting a stale credential under a
disabled section. This behavior was never written down as a deliberate design rule; each round
justified its own change locally, and a reader assembling the two files today cannot tell, without
re-deriving it from the push mappers in `apps/cli/src/legacy/commands/config/push/config-sync/`,
whether the accumulated canonicalization is a coherent design or 29 rounds of unrelated patches.

## Decision

Both normalizers are **post-push convergence predictors**, not verbatim projections of their input.
`fromConfigDocument(doc)` returns what the hosted config _will look like after a push of `doc`_ — not
`doc`'s own hosted-section values as declared. `fromApiProjectConfig(response)` similarly canonicalizes
the response into the same convergent form, so a `ProjectConfig` built from either side compares
structurally equal to the other exactly when pushing the document would produce the response (modulo
the granularity gaps `./project-config.ts`'s own `ProjectConfig` docstring already documents). This is
the design rule the accumulated behavior below already implements; this ADR names it and enumerates
the concrete families so a future change can be judged against the rule instead of added ad hoc.

Concrete behavior families, by normalizer:

**`fromConfigDocument`** (`packages/config/src/project-config/project-config.ts`):

- SMS provider push precedence: the push switch selects the first enabled provider in a fixed order
  and sends only that one, so a document enabling several providers converges on only the first
  staying enabled (`applySmsProviderPrecedence`, `project-config.ts:386-403`).
- Disabled-sentinel pruning: a section/entry whose `enabled` is `false` drops the sibling fields the
  legacy push does not manage while the toggle is off, since projecting them would fabricate drift
  against the disabled state's real hosted shape (`applyDisabledSentinels`,
  `DISABLED_SENTINEL_PRUNES`/`DISABLED_SENTINEL_ENTRY_SWEEPS`, `project-config.ts:406-528` — the same
  function also carries the cross-section `rate_limit.email_sent` rule, gated on an EXPLICIT
  `smtp.enabled === false`, never on absence).
- CSV re-splitting (`canonicalizeCommaJoinedArray`), uint clamping (`clampToUint`/`clampDocumentUint`),
  `test_otp` map canonicalization (`canonicalizeTestOtpMap`), duration/byte-size re-quantization
  (`canonicalizeDurationString`, `canonicalizeWholeSecondsDurationString`, `canonicalizeFileSizeLimit`),
  and `smtp.port`'s `String`→`parseUint16` round trip (mirroring the push wrapper's own
  `String(local.email.smtp.port)`, so a fractional or out-of-range document port is REMOVED rather
  than kept, matching what the API arm reports for the same pushed state) — all in
  `registry-auth.ts`/`registry.ts` — each replays the push pipeline's own serialize-then-parse or unit
  conversion so a document spelling and the API's post-push spelling of the same logical value
  converge on one representation.
- **Unmanaged-by-push containers omitted on the document arm** (threads 1 and 3 of a human review round
  on PR #6339) — a family of DOCUMENT-ARM-ONLY omissions, none applied to the API arm, whose common
  thread is "push structurally cannot communicate this state, so projecting a decoded value for it
  would assert something that survives push as drift":
  - `api.max_rows`: `apiToUpdateBody` only sends it when strictly positive (api.sync.ts:141) — a
    non-positive document value is OMITTED rather than clamped to `0` (`normalizeDocumentMaxRows`,
    `registry.ts`).
  - `storage.analytics`/`storage.vector`: `storageToUpdateBody` only emits Iceberg/Vector inside a
    truthy `if (local.analytics.enabled)`/`if (local.vector.enabled)` branch (storage.sync.ts:287-300,
    never a `{enabled: false}` shape) — a disabled container is OMITTED entirely rather than projected
    as `{enabled: false}` (`applyPushUnmanagedOmissions`, `project-config.ts`).
  - `auth.oauth_server`: `authToUpdateBody` has no oauth_server handling at all — the whole subtree is
    OMITTED unconditionally, regardless of `enabled` (`applyPushUnmanagedOmissions`, superseding the
    round-17 `DISABLED_SENTINEL_PRUNES` entry for this arm specifically).
  - The full raw-presence-gated set from thread 1 (`db.ssl_enforcement`, `storage.image_transformation`,
    `storage.s3_protocol`, `auth.captcha`, each of the six `auth.hook.<name>` entries, `auth.email.smtp`
    plus `auth.rate_limit.email_sent`, and non-`apple` `auth.external` providers) — see the "Limits"
    section below for the full mechanism (`applyRawPresenceMask`, needs a `document` operand).

  CLI-2266's lockstep rule covers this whole family: if push ever gains the ability to communicate one
  of these states explicitly (e.g. an explicit `max_rows: 0`/"unset" sentinel, oauth_server fields, a
  presence-independent smtp signal), the corresponding omission here must flip in the same change that
  ships the push-side capability — an omission this family models is a statement about push's CURRENT
  limitations, not a permanent semantic ceiling.

**`fromApiProjectConfig`** (`registry-auth.ts`, `registry.ts`, `project-config.ts`):

- API `null` on a gating boolean canonicalizes to `enabled: false` rather than being skipped, so the
  disabled-sentinel sweep below has a flag to key on (`gatedBoolRow`, `registry-auth.ts:577-584`; the
  SMTP host anchor's `null → enabled: false`, `registry-auth.ts:815-827`).
- The same disabled-sentinel pruning as the document arm runs on the API arm's output too
  (`applyDisabledSentinels` is shared, `project-config.ts:1071`), so both arms report the identical
  mapped shape for the same logical hosted state — including the `rate_limit.email_sent` rule: an
  ABSENT `smtp_host` (this arm's own three-state fix, `smtpExplicitlyDisabledInAttributes`,
  `registry-auth.ts`) does not prune it either.
- Typed throws on out-of-domain mapped values a real platform response should never carry — e.g. a
  negative `storage.file_size_limit` (`registry.ts:505-525`) — surface as a `ProjectConfigParseError`
  rather than a canonicalized-but-wrong value.
- The `data.type` discriminator gate rejects an envelope carrying another resource's `type`
  (`assertProjectConfigResourceType`, `project-config.ts:611-626`).
- Orphan-secret digest type validation: a value at a known secret-shaped path with no row of its own
  (`unmappedSecretApiPaths`) is still validated as string-or-null, even though its value is never
  emitted (`applyMappingRows`'s trailing loop, `project-config.ts:811-821`).

## Limits (presence-relativity) — now with a first-class remedy

**Update (2026-08-27, thread 1 of a human review round on PR #6339)**: the limit this section
originally documented as unfixable now has a first-class remedy. `fromConfigDocument` accepts a
second operand shape, `CliConfigWithRawPresence` (`{ config, document }` — `LoadedCliConfig`,
`packages/config/src/config-document.ts`, is structurally assignable to it without a cast), and when
`document` is supplied it applies `applyRawPresenceMask`, mirroring the legacy push pipeline's own
raw-presence gates (`apps/cli/src/legacy/commands/config/push/push.raw-presence.ts`'s
`legacyPresenceIn`, `config-sync/auth.sync.ts`'s `AuthPresence`) exactly: `db.ssl_enforcement`,
`storage.image_transformation`, `storage.s3_protocol`, `auth.captcha`, each of the six
`auth.hook.<name>` entries, `auth.email.smtp` (and, as a consequence, `auth.rate_limit.email_sent`),
and `auth.external` (kept to raw-declared providers plus the always-sent `apple`) are all now omitted
from the projection exactly when the raw file never declared them — closing the `auth.external`/
`auth.email.smtp` gaps this section originally described as open. **The original analysis below is
retained for its verified boundary and its rationale for why the fix could not live inside a bare
`EffectiveConfig` operand** — the same analysis is what motivated the `document`-based remedy;
without a `document` (i.e. a bare `EffectiveConfig`/`CliConfig` operand, still a fully supported
input), the limit as originally described still applies in full, and the guidance below (strip
defaults, intersect comparable paths) still stands as the fallback.

The convergence prediction above is exact only for fields the INPUT actually speaks for — it degrades
for `fromConfigDocument` specifically because the legacy push pipeline reads a signal `@supabase/config`
decode discards: whether the raw `config.toml`/`.json` FILE literally wrote a key, as opposed to a
decoded value merely holding that key's schema default. Verified directly (`getDefaultCliConfig()`, a
fully-materialized decoded `CliConfig`, is the common real `fromConfigDocument` operand — its exported
type accepts any `EffectiveConfig`, and a full `CliConfig` is one):

- `auth.external` materializes all 19 provider entries after decode (`apple`, `azure`, `bitbucket`, …),
  each defaulting to `{enabled: false, client_id: "", …}`, regardless of whether the raw file mentions
  any of them. The legacy push mapper (`authSubsetFromConfig`,
  `apps/cli/src/legacy/commands/config/push/config-sync/auth.sync.ts:1075-1084`) instead tracks which
  providers the raw file actually declared (a `presence.externalProviders` set built from the raw
  TOML/JSON walk, not from a decoded value) and only ever emits `apple` plus that set — never all 19.
- `auth.email.smtp` decodes to `{enabled: false}` when the raw file never declares `[auth.email.smtp]`
  at all (`Schema.optionalKey` on the field itself, but `enabled` inside it carries its own default).
  The push mapper instead gates the ENTIRE smtp subset on raw presence (`!presence.smtp ||
smtpConfig === undefined` skips it, `auth.sync.ts:1020-1024`) — a decoded document cannot distinguish
  "the file never mentioned SMTP" from "the file wrote `enabled = false`" once decode has run, because
  both read back identically.
- The one field this could plausibly break today, `rate_limit.email_sent`, does not currently diverge:
  push only sends it when `local.email.smtp !== undefined && local.email.smtp.enabled`
  (`auth.sync.ts:2310-2313`), and since a decoded document's `smtp.enabled` is always `true` or `false`
  (never `undefined`), this package's own cross-section rule (`applyDisabledSentinels`, gated on an
  EXPLICIT `smtp.enabled === false`, above) already agrees with push in both the "raw file absent" and
  "raw file declared, disabled" cases. The general principle — decode cannot recover "the file never
  mentioned this" — still holds; this field simply doesn't have a push-side branch that depends on the
  distinction, unlike the provider set above.

Raw-presence tracking or default-omission from decoded values ALONE remains impossible, and always
will be — the distinction above is not recoverable once decode has already run on a value with no
further context, and `@supabase/config`'s decoded `CliConfig`/`EffectiveConfig` type carries none.
That is exactly why the remedy takes the raw document as a SEPARATE, explicit operand
(`CliConfigWithRawPresence.document`) rather than trying to infer presence from `config` alone: the
"was this key written in the file" bit lives only on the raw, pre-decode object, and a caller must
supply it if it wants this class of drift closed. A caller with no `document` available (a config
constructed in-memory, e.g. `getDefaultCliConfig()`'s own memo, which never had a raw file to begin
with) is not a regression — it simply reduces to the pre-remedy behavior this section originally
described in full.

Practical guidance: `fromConfigDocument`'s convergence claim holds EXACTLY for a genuinely sparse
`EffectiveConfig` operand — one built to carry only the keys the caller means to speak for (e.g. a
literal `{ api: { max_rows: 100 } }`, or one already run through `omitDefaultValues`) — and, as of the
remedy above, for a fully-materialized decoded document too, PROVIDED its `document` is supplied
alongside it. Without a `document`, it holds only "exact modulo schema defaults", and a caller
composing `fromConfigDocument`'s output with the ADR 0018 subtraction core for a genuine
local-vs-remote diff (CLI-2156) must first strip schema defaults with `omitDefaultValues` and intersect
to the fields both operands actually speak for (the existing `ProjectConfig` docstring rule,
`comparableProjectConfigPaths`/`isComparableProjectConfigPath`) — neither step is new to this ADR, but
this is why both are load-bearing rather than optional cleanup in that fallback case.

The one residual category the remedy does NOT resolve even WITH a `document` is an
unconditionally-mapped field with no "the local document is silent here" signal at all — the finer,
per-path granularity gap `ProjectConfig`'s own docstring already documents, distinct from raw presence
entirely (there is no raw key whose absence could gate it, since the registry maps it regardless). That
is honest-but-push-unactionable drift: real per the convergence definition above, but not something a
user can act on by editing their file. Tracked on CLI-2266, not fixed here. The `api.max_rows > 0` push
gate this category used to include is a plain VALUE gate rather than a raw-presence one, and IS now
modeled — see the "unmanaged-by-push containers" family above.

## Rationale

- The alternative — verbatim projection on both sides — is what motivated every one of the 29 rounds'
  individual fixes: a verbatim `fromConfigDocument` reports a document's literal declared state (two
  SMS providers both `enabled: true`, a retained SMTP credential under a disabled section) that no
  push ever actually produces hosted, and a verbatim `fromApiProjectConfig` reports whatever noise the
  platform retains behind a disabled toggle. Either one, fed into the ADR 0018 subtraction core,
  manufactures drift a user did not create and cannot fix by editing their file — CLI-2156's
  `config diff` is exactly the consumer this would have broken.
- Both normalizers converging on the _same_ predicted post-push shape (rather than each faithfully
  representing its own input) is what makes the ADR 0018 subtraction core's simple structural
  comparison meaningful at all — the alternative is teaching the diff core push-specific exception
  logic instead of teaching each normalizer to predict push's own outcome once.
- Naming this now, rather than after a 30th round adds another undocumented canonicalization, is the
  same rationale as ADR 0019 and ADR 0020: the cost of writing down a convention only grows the longer
  it stays implicit in scattered per-round justifications.

## Consequences

### Positive

- `config diff`/Studio's drift page compare two `ProjectConfig` values that both predict the same
  real-world convergence point, eliminating the phantom-drift false positives a verbatim projection on
  either side would produce.
- Future changes to either normalizer have a rule to check against: does this change make the output
  track the legacy push pipeline's actual post-push state more closely, or does it drift toward a
  verbatim (and therefore drift-fabricating) reading of the input.

### Negative

- **`fromConfigDocument` is deliberately lossy about the user's own file.** Its output is not what the
  user wrote in `supabase/config.toml`/`.json` — it is a prediction of what pushing that file would
  produce hosted. A consumer must not render `fromConfigDocument`'s output as "your local config"; the
  only correct rendering is "what pushing your local config will result in on the platform."
- The flip side of convergence: this package's registry/sentinel semantics must track the _real_ push
  mapper's behavior, not an independent guess at it. Today the registry rows are mined from the
  existing push-direction `*.sync.ts` helpers under `apps/cli/src/legacy/commands/config/push/
config-sync/` rather than derived from a push mapper this package owns; a push-mapper implementation
  that both directions share is the tracked follow-up (CLI-2230's own `inverse`/push-mapper note in
  `registry-row.ts`) and, until it lands, a change to the legacy push pipeline's behavior can silently
  desync this package's prediction from what push actually does.
- **Resolved incompleteness** (originally recorded here, now modeled — human review round on PR #6339,
  thread 2): the `api.max_rows` push gate (the legacy pipeline manages `max_rows` only while
  `max_rows > 0`, per the API's own push-direction convention) is now modeled on the DOCUMENT arm —
  see the "unmanaged-by-push containers" family above. The API arm is unaffected (`0`/negative there is
  real, reported hosted state, not a push-gate artifact).

## Alternatives Considered

1. **Verbatim projection on both sides, push-specific exceptions handled in the diff consumer**:
   rejected. This pushes push-pipeline knowledge into every consumer of `ProjectConfig` (CLI-2156,
   Studio, and any future one) instead of centralizing it once in the shared package; it also cannot
   be done correctly without the same registry data this package already owns.
2. **Verbatim projection with a separate `predictPostPush` transform layered on top**: rejected as
   unnecessary indirection — every canonicalization already lives at the exact row/field it applies
   to (`normalizeDocument`/`transform` on `ProjectConfigMappingRow`), and a separate pass would either
   duplicate that per-row knowledge or need to re-derive it generically.
3. **Leave the convention undocumented, relying on the 29 rounds' individual code comments**: rejected
   for the same reason ADR 0019/0020 reject their own "leave it in PR history" alternative — a reader
   assembling the two files today cannot tell a coherent design from an accumulation of unrelated
   patches without this ADR naming the rule they jointly implement.

## Related Decisions

- [ADR 0018](0018-sparse-config-subtraction.md): Sparse Config Subtraction — the structural comparison
  core both normalizers' output feeds; this ADR does not change that core, only what the two
  `ProjectConfig`-producing normalizers feed into it.
- [ADR 0019](0019-config-api-response-passthrough.md): Raw API-Response Passthrough — governs
  `_apiResponse`/`unmappedApiFields`, the escape hatch for whatever `fromApiProjectConfig`'s
  canonicalization does not (yet) cover; its 2026-08-27 addendum refines the leniency boundary this
  ADR's API-arm behavior families rely on (JSON-reachable oddities always decode; typed throws are
  reserved for out-of-domain values on mapped fields).
- [ADR 0020](0020-config-naming-vocabulary.md): Config Naming Vocabulary — defines `ProjectConfig`
  itself; this ADR documents what that type's two producing functions actually compute.

## See Also

- Linear: CLI-2230 (PR supabase/cli#6339, `toProjectConfig`), CLI-2156 (`config diff`, the motivating
  consumer), CLI-2266 (the presence-relativity drift categories the Limits section defers), CLI-2267
  ("Pin @supabase/config's replicated legacy parsers with parity fixtures in apps/cli" — the
  `project-config-presence-parity.unit.test.ts` cross-check this ADR's remedy added is a stopgap for
  this issue's proper fixture set)
- `packages/config/src/project-config/registry-row.ts` — the `inverse` field's own note that a
  push-mapper sharing this registry is a follow-up, not yet implemented
- Decided by Colum Ferry via drift-audit adjudication on PR supabase/cli#6339, 2026-08-27
