# 0019. Raw API-response passthrough on API-sourced config (`_apiResponse`)

**Status**: accepted
**Date**: 2026-08-24

## Problem Statement

`@supabase/config` is headed for npm as the shared config contract for the
CLI, Studio, and other consumers, and it will grow a mapping from the
Management API's `/v2/projects/{ref}/config` response into the config shape
(the translation layer `config diff`/`config pull` and Studio's drift
detection all need). The Management API evolves continuously; the package will
publish deliberately. Without a designed escape hatch, every new API field is
unreachable to package consumers until someone maps it and cuts a release —
the package's release cadence becomes a bottleneck on every service team's
API velocity.

Two properties of the v2 response make a naive passthrough dangerous:

- Secrets are returned as HMAC digests of their values (e.g. inside the
  `auth` attribute record). Anything that carries the raw response must never
  be written into a config file.
- Config values flow through structural walks — the sparse subtraction core
  from ADR 0018, default omission, encode-to-file. A non-config key visible
  to those walks would register as drift or get persisted.

## Decision

API-sourced config values carry the raw response, governed by five rules:

1. **`_apiResponse?: Record<string, unknown>`** — an optional field on the
   config value produced from an API response, holding the raw v2
   `data.attributes` object verbatim. It is present only when the value was
   built from an API response; file-sourced config never has it. Its absence
   therefore does not mean "no unmapped fields exist". It is defined as a
   non-enumerable property (or held out-of-band, e.g. in a module-private
   `WeakMap<ConfigValue, RawApiResponse>`) rather than an ordinary object
   field, so `JSON.stringify`, object spread, and any encoder outside this
   package — not just the package's own — cannot observe it by construction.
   The metadata-key strip rule below is defense-in-depth for this package's
   own structural walks, not the sole safeguard.
2. **Lenient decode, applied before the strict generated schema sees the
   body.** The CLI fetches the v2 config response via `@supabase/api`'s
   `executeRaw` (`packages/api/src/internal/client.ts`), not `execute`.
   `execute` decodes through the generated `V2GetProjectConfigOutput`
   `Schema.Struct`, which discards excess properties, so by the time
   `@supabase/config`'s lenient schema ran on that output any API-ahead field
   would already be gone. `executeRaw` returns the response undecoded;
   `@supabase/config`'s schema then decodes `data.attributes` and must pass
   unknown keys through without failing. This lenient decode is the primary
   protection against API-ahead-of-package skew; `_apiResponse` is only the
   access mechanism for what it let through.
3. **One metadata-key rule, scoped to fixed struct shapes.** `_apiResponse`
   and `$schema` are metadata, not config, wherever they occur as a declared
   field of a fixed `Schema.Struct` (the config document root, or the value
   object an API-sourced section attaches `_apiResponse` to). The rule is a
   position match on those two reserved names, not a `$`/`_` prefix match,
   and it never reaches into a dynamic `Schema.Record` key space: function
   slugs (`functions.<slug>`, e.g. `functions._health`), edge runtime secret
   names (`edge_runtime.secrets.<name>`, e.g. `secrets._TOKEN`), env var
   names, and other user-named keys keep whatever leading `_`/`$` character
   they're given, because those keys are user data, not metadata, regardless
   of spelling. Reserved-name matches are excluded from every structural walk
   (sparse subtraction, default omission, value-origin tracking) and from
   every encode/persist path. The `$schema` key preserved by `io.ts` is the
   existing precedent; `_apiResponse` is the second member of the same rule,
   implemented once in the shared walk core rather than per call site.
4. **Never persisted.** Because encode strips metadata keys, `_apiResponse`
   (and its HMAC'd secret digests) can never land in `config.toml` /
   `config.json`, including via `config pull`-style flows.
5. **Fallback, not contract — with a secret carve-out.** When a raw key later
   graduates into the typed mapping, the typed field wins; the raw key
   remains readable but its naming, units, or polarity may differ from the
   typed field (the API↔config mapping includes renames, boolean inversions,
   and unit conversions). This precedence does not apply to fields the schema
   annotates `x-secret` (`packages/config/src/lib/env.ts`'s `secret()` /
   `env({ secret: true })`, e.g. `edge_runtime.secrets.*`): the API only ever
   returns an HMAC digest for these, never the underlying value, so letting
   the typed field win would hand the digest to the normal encoder and
   persist it despite rule 4. For `x-secret` fields the mapping omits the
   API-sourced value entirely, leaving any locally configured value
   untouched. Consumers needing "which API fields does this package version
   not understand" use a registry-derived `unmappedApiFields()` helper (raw
   attributes minus the keys the mapping consumed) rather than a second
   stored field.

## Rationale

- The alternative to rule 2 — a closed decode — converts every additive API
  change into a hard decode failure for all published consumers. That is
  strictly worse than an unmapped-but-reachable field. Routing through
  `executeRaw` rather than `execute` is required, not incidental: the
  generated client's strict `Schema.Struct` decode already drops excess
  properties, so a lenient decode layered on top of it would have nothing
  left to be lenient about.
- Rule 3 is scoped to fixed struct positions, not a `$`/`_` prefix match,
  because the config schema uses dynamic `Schema.Record` keys (function
  slugs, edge runtime secret names, env var names) that legitimately start
  with either character. A prefix match would make the metadata rule silently
  drop user config through the same structural walks it's meant to protect.
  Scoped to reserved names, it still exists because the ADR 0018 subtraction
  core compares config values structurally: a remote config carrying
  `_apiResponse` would otherwise diff as drifted against every baseline,
  producing exactly the phantom-drift false positives the drift feature is
  trying to eliminate.
- Storing the whole raw response (rule 1) rather than only the unmapped
  leftovers keeps the field's contents stable across package releases;
  the leftovers are derivable and shrink release-over-release, which is
  correct semantics for a helper but confusing semantics for stored data.
  Non-enumerable/out-of-band storage is required rather than a plain field
  because the metadata-key rule only protects this package's own walks —
  a shared npm contract also gets serialized by `JSON.stringify`, object
  spread, and consumer-written encoders this package doesn't control.
- The rule 5 secret carve-out exists because typed graduation and the
  metadata-key rule solve different problems: metadata-key strips the raw
  copy, but a graduated secret's *typed* value is not metadata-keyed and
  remains eligible for the normal encoder. Without the carve-out, an HMAC
  digest could reach `config.toml` through the typed field even though rule
  4 successfully blocked the raw one.

## Consequences

### Positive

- Consumers are decoupled from the package's publish cadence for read access
  to new API fields.
- One metadata-key rule covers `$schema` and `_apiResponse` together, in one
  shared walk implementation.
- `unmappedApiFields()` doubles as a mapping-completeness check: a
  nonempty result on a known API version is a to-do list for the registry.

### Negative

- Field presence leaks provenance (API-sourced vs file-sourced). Accepted —
  it is arguably a feature — but code must not treat absence as "fully
  mapped".
- Two representations of graduated fields coexist (raw and typed) and can
  disagree in naming/units/polarity; the documented typed-wins precedence,
  minus the secret carve-out, mitigates but cannot remove the confusion risk.
- Every future structural walk must honor the metadata-key rule, and that
  rule must stay position-scoped (reserved struct field, not string prefix)
  as new dynamic `Schema.Record` sections are added; keeping the walks
  funneled through the shared core is what makes this tractable.
- The mapping layer must special-case every `x-secret`-annotated field to
  skip typed graduation, rather than treating all API-sourced fields
  uniformly; missing one lets a digest reach the encoder.
- CLI callers must use `executeRaw` for this endpoint instead of the
  generated `execute`, forgoing the generated client's typed output for the
  v2 config response specifically.

## Alternatives Considered

1. **Store only unmapped leftovers (`_unmapped`)**: contents change with
   every package release even when the API response is identical; unstable
   stored data. Derive leftovers via helper instead.
2. **Return a `{ config, raw }` pair instead of embedding**: keeps config
   values walk-clean by construction, but the raw half does not travel with
   the value through application code and state stores; each consumer would
   rebuild the pairing. Embedding plus the strip rule is more ergonomic for
   the same safety.
3. **Strict decode of the v2 attributes**: rejected outright; see Rationale.
4. **Inline passthrough of unknown keys per section** (zod
   `.passthrough()`-style): unknown API keys arrive in API naming/units,
   which for this mapping differ from config naming (renames, inversions,
   unit conversions). Inlining them beside typed config fields misrepresents
   them as config values and puts them back in the path of structural walks.

## Related Decisions

- ADR 0018: sparse config subtraction — defines the structural walks that the
  metadata-key rule scopes out.
- ADR 0009: configuration schema & validation.

## See Also

- supabase/supabase#48906 — Studio config-drift work; vendors a temporary
  schema mirror explicitly awaiting the published `@supabase/config` package.
- Linear: CLI-2155/CLI-2156 (sparse + diff), CLI-2231 (entrypoint split),
  CLI-2234 (public-surface audit), CLI-2169 (publish umbrella).
