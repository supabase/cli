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
  `test_otp` map canonicalization (`canonicalizeTestOtpMap`), and duration/byte-size re-quantization
  (`canonicalizeDurationString`, `canonicalizeWholeSecondsDurationString`, `canonicalizeFileSizeLimit`,
  all in `registry-auth.ts`/`registry.ts`) — each replays the push pipeline's own
  serialize-then-parse or unit conversion so a document spelling and the API's post-push spelling of
  the same logical value converge on one representation.

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
- **Known incompleteness**: the `api.max_rows` push gate (the legacy pipeline manages `max_rows` only
  while `max_rows > 0`, per the API's own push-direction convention) is not modeled by either
  normalizer today — a value like `max_rows: 0` still projects on both arms rather than being treated
  as unmanaged. This is a gap in the convergence prediction, not a decision that `max_rows: 0` is
  meaningful; closing it is deferred rather than blocking this ADR.

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
  consumer)
- `packages/config/src/project-config/registry-row.ts` — the `inverse` field's own note that a
  push-mapper sharing this registry is a follow-up, not yet implemented
- Decided by Colum Ferry via drift-audit adjudication on PR supabase/cli#6339, 2026-08-27
