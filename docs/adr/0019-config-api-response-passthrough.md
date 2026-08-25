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
   It is not a declared field of any decode schema: file decoding can never
   produce it, and the API mapping attaches it only after decode. A
   `_apiResponse` key found inside a config *file* is therefore ordinary
   unknown input at struct positions and ordinary user data at dynamic
   record positions — presence remains a reliable API-provenance signal.
   Invisibility to serialization implies invisibility to generic copying:
   `{ ...config }`, `structuredClone`, and serializing state stores yield a
   valid config value *without* the raw response, by design. Safety outranks
   propagation here, and absence is already a defined state under this rule;
   the package exposes a read accessor and the mapping's attach step for
   consumers that must carry the raw across a copy boundary explicitly.
2. **Lenient decode, applied before the strict generated schema sees the
   body.** The CLI fetches the v2 config response via `@supabase/api`'s
   `executeRaw` (`packages/api/src/internal/client.ts`), not `execute`.
   `execute` decodes through the generated `V2GetProjectConfigOutput`
   `Schema.Struct`, which discards excess properties, so by the time
   `@supabase/config`'s lenient schema ran on that output any API-ahead field
   would already be gone. `executeRaw` returns the response undecoded and
   deliberately does not filter on HTTP status, so the caller checks the
   status and maps non-2xx responses to API errors before any decode — as
   existing `executeRaw` callers do — rather than feeding an error body into
   the config schema. `@supabase/config`'s schema then decodes
   `data.attributes` and must tolerate unknown keys without failing.
   Tolerate, not inline: an unknown key never lands on the decoded
   `ProjectConfig` (that is Alternative 4, rejected) — it stays reachable
   only through the raw object rule 1 attaches. This lenient decode is the
   primary protection against API-ahead-of-package skew; `_apiResponse` is
   the only access mechanism for what it tolerated.
3. **Metadata is invisible to walks by construction, not filtered by key.**
   Neither reserved name is excluded from the structural walks (sparse
   subtraction, default omission, value-origin tracking) by a key check in
   the walk core — the walks never see them at all. `$schema` lives entirely
   at the io boundary: `io.ts` reads it off the raw parsed document before
   schema decode and re-attaches it on write, so it never exists on a
   decoded config value. `_apiResponse` is non-enumerable (rule 1), so
   `Object.entries`-based walks — `sparse.ts`'s `subtractValue` included —
   skip it without knowing it exists. No walk needs schema or path context,
   and dynamic `Schema.Record` key spaces are safe automatically: an
   enumerable, file-supplied key that merely spells a reserved name
   (`functions._apiResponse` as a function slug,
   `edge_runtime.secrets._TOKEN` as a secret name) is user data and flows
   through every walk normally, because metadata status comes from *how the
   property is attached*, never from how the key is spelled.
4. **Divergent persistence policies.** The reserved names share walk
   invisibility but not a persistence rule. `$schema` is document metadata
   that must be written: `io.ts`'s `toConfigDocument` re-attaches it on
   every persist so editor and schema tooling keep working. `_apiResponse`
   must never be written — and cannot be: non-enumerable means no encoder,
   this package's or a consumer's, can see it, so it (and its HMAC'd secret
   digests) cannot land in `config.toml`/`config.json`, including via
   `config pull`-style flows.
5. **Fallback, not contract — with a secret carve-out.** When a raw key later
   graduates into the typed mapping, the typed field wins; the raw key
   remains readable but its naming, units, or polarity may differ from the
   typed field (the API↔config mapping includes renames, boolean inversions,
   and unit conversions). This precedence does not apply to fields the schema
   annotates `x-secret` (`packages/config/src/lib/env.ts`'s `secret()` /
   `env({ secret: true })` — e.g. `auth.external.<provider>.secret` or
   `auth.captcha.secret`, which map from the v2 response's `auth` attribute
   record): the API only ever
   returns an HMAC digest for these, never the underlying value, so letting
   the typed field win would hand the digest to the normal encoder and
   persist it despite rule 4. For `x-secret` fields the mapping omits the
   API-sourced value entirely. Omission alone only governs the mapping:
   flows that rewrite a config file (a `config pull` that persists the
   merged result) must source `x-secret` fields from the existing local
   document, or the rewrite would drop the user's secret along with the
   digest; and drift comparison must treat `x-secret` fields as not
   comparable, since a local plaintext or `env(...)` reference can never
   meaningfully equal a remote digest. Local-only secrets such as
   `edge_runtime.secrets.*` never appear in the API response at all; the
   graduation carve-out is moot for them, and the source-from-local
   obligation is what keeps them in the file. Consumers needing "which API
   fields does this package version not understand" use a registry-derived
   `unmappedApiFields()` helper rather than a second stored field. The
   subtraction is by path, not by top-level key: the registry records every
   mapped API path (`auth.<setting>`, `database.major_version`, …) and the
   helper walks the raw attributes deeply, so a new field nested inside an
   existing section — the common API-ahead case — still surfaces.

## Rationale

- The alternative to rule 2 — a closed decode — converts every additive API
  change into a hard decode failure for all published consumers. That is
  strictly worse than an unmapped-but-reachable field. Routing through
  `executeRaw` rather than `execute` is required, not incidental: the
  generated client's strict `Schema.Struct` decode already drops excess
  properties, so a lenient decode layered on top of it would have nothing
  left to be lenient about.
- Rule 3 rejects both a `$`/`_` prefix match and schema-aware key filtering
  in the walk core. A prefix match would silently drop user config: dynamic
  `Schema.Record` keys (function slugs, edge runtime secret names, env var
  names) legitimately start with either character. And threading schema/path
  context through `subtractValue` just to recognize two reserved names is
  complexity with no payoff once those names never occupy enumerable
  positions in the first place — attachment mode, not key inspection, is
  what makes a property metadata. Walk invisibility still matters because
  the ADR 0018 subtraction core compares config values structurally: an
  enumerable `_apiResponse` would diff as drifted against every baseline,
  producing exactly the phantom-drift false positives the drift feature is
  trying to eliminate.
- Storing the whole raw response (rule 1) rather than only the unmapped
  leftovers keeps the field's contents stable across package releases;
  the leftovers are derivable and shrink release-over-release, which is
  correct semantics for a helper but confusing semantics for stored data.
  Non-enumerable/out-of-band storage is required rather than a plain field
  because a shared npm contract gets serialized by `JSON.stringify`, object
  spread, and consumer-written encoders this package doesn't control. The
  same mechanism that hides the raw from serializers necessarily hides it
  from generic copies — a property `JSON.stringify` skips is a property
  `{ ...spread }` skips. The ADR resolves that tension in favor of safety:
  a copy that silently kept secret digests would be a leak, while a copy
  that drops the escape hatch is just a config value in the absence state
  rule 1 already defines.
- The rule 5 secret carve-out exists because typed graduation and rule 3
  solve different problems: walk invisibility hides the raw copy, but a
  graduated secret's *typed* value is an ordinary enumerable config field
  and remains eligible for the normal encoder. Without the carve-out, an
  HMAC digest could reach `config.toml` through the typed field even though
  rule 4 successfully blocked the raw one.

## Consequences

### Positive

- Consumers are decoupled from the package's publish cadence for read access
  to new API fields.
- Both reserved names stay out of the structural walks by construction —
  zero key-checks in the walk core to maintain or get wrong.
- `unmappedApiFields()` doubles as a mapping-completeness check: a
  nonempty result on a known API version is a to-do list for the registry.

### Negative

- Field presence leaks provenance (API-sourced vs file-sourced). Accepted —
  it is arguably a feature — but code must not treat absence as "fully
  mapped".
- Two representations of graduated fields coexist (raw and typed) and can
  disagree in naming/units/polarity; the documented typed-wins precedence,
  minus the secret carve-out, mitigates but cannot remove the confusion risk.
- The guardrail rests on attachment invariants: `_apiResponse` is safe only
  while attached non-enumerably (or out-of-band), `$schema` only while it
  stays at the io boundary. A refactor that reifies either as an ordinary
  enumerable field silently reintroduces both phantom drift and the
  persistence leak.
- Generic copies (`{ ...spread }`, `structuredClone`, serializing state
  stores) drop the raw metadata by design; a consumer that must carry it
  across such a boundary re-attaches it explicitly via the package's
  accessor/attach helpers.
- The mapping layer must special-case every `x-secret`-annotated field to
  skip typed graduation, rather than treating all API-sourced fields
  uniformly; missing one lets a digest reach the encoder. Pull-style write
  flows carry the matching obligation to source `x-secret` fields from the
  local document, and drift comparison must skip them.
- CLI callers must use `executeRaw` for this endpoint instead of the
  generated `execute`, forgoing the generated client's typed output for the
  v2 config response specifically.

## Alternatives Considered

1. **Store only unmapped leftovers (`_unmapped`)**: contents change with
   every package release even when the API response is identical; unstable
   stored data. Derive leftovers via helper instead.
2. **Return a `{ config, raw }` pair instead of embedding**: equally
   walk-clean, but the pair must be threaded through every signature and
   store even for the dominant in-process case, where a non-enumerable
   embedded property travels free with the object reference. Both designs
   lose the raw across serializing boundaries (see Consequences), so the
   pair's only advantage disappears while its ergonomic cost remains.
3. **Strict decode of the v2 attributes**: rejected outright; see Rationale.
4. **Inline passthrough of unknown keys per section** (zod
   `.passthrough()`-style): unknown API keys arrive in API naming/units,
   which for this mapping differ from config naming (renames, inversions,
   unit conversions). Inlining them beside typed config fields misrepresents
   them as config values and puts them back in the path of structural walks.

## Related Decisions

- ADR 0018: sparse config subtraction — defines the structural walks that
  rule 3 keeps the metadata invisible to. This ADR supersedes 0018's
  assignment of API→`ProjectConfig` translation to the diff core (CLI-2156):
  the mapping lives in `@supabase/config` so the CLI and Studio share one
  implementation. 0018 is amended accordingly; its subtraction core stays
  independent of the API shape.
- ADR 0009: configuration schema & validation.

## See Also

- supabase/supabase#48906 — Studio config-drift work; vendors a temporary
  schema mirror explicitly awaiting the published `@supabase/config` package.
- Linear: CLI-2155/CLI-2156 (sparse + diff), CLI-2231 (entrypoint split),
  CLI-2234 (public-surface audit), CLI-2169 (publish umbrella).
