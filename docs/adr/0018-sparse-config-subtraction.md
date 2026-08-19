# 0018. Sparse Config Subtraction

**Status**: proposed
**Date**: 2026-08-18

## Problem Statement

`config diff` (CLI-2156) and `config pull` (CLI-2064) compare a project's remote configuration against the local `config.toml` to surface *drift*: any difference between the project's effective remote configuration and the local file. The remote endpoint (`GET /v2/projects/{ref}/config`) returns the *effective* config — every setting reported, defaulted or not — and a locally decoded `ProjectConfig` likewise has every default filled in. Comparing these full objects directly would drown the user in hundreds of identical default values. CLI-2155 asks for a stored reference of config defaults and a mapping function that omits values matching them, so diffs stay readable and pulled files stay sparse.

The trap is where that mapping recurses. A `[remotes.<label>]` block declares config overrides for a specific [persistent Supabase branch](https://supabase.com/docs/guides/local-development/cli/config#branching-config): the branch's project ref in `project_id` binds the block to the branch (the label is a user-chosen alias and is never matched on), any root config option can be overridden inside it, and unspecified options inherit from the *base config* — the root-scope fields of the file, before any remote block is overlaid. The block is therefore itself a sparse overlay over the merged base config. A value in a remote block that happens to equal a *global default* is not redundant: if the base config overrides the same property, removing the remote's value silently changes what that branch resolves to.

## Decision

`@supabase/config` exports a pure, parameterized subtraction core:

- `getDefaultProjectConfig()` — the default config, derived by decoding `{}` through `ProjectConfigSchema` (memoized). The schema's `default` annotations and decoding defaults are the single source of truth; no hand-maintained defaults table exists.
- `subtractProjectConfig(config, baseline)` — returns the sparse config `config − baseline`: every value strictly deep-equal (order-sensitive) to the baseline's is removed, then sections left empty are dropped recursively.
- `omitDefaultValues(config)` — `subtractProjectConfig` with the default config as baseline.

What the output *is* depends on the baseline. In the primary case — subtracting the default config (`omitDefaultValues`) — the result is itself a valid config document: re-decoding refills exactly what was removed, so it denotes the same effective config *under the current schema's defaults*. That parenthetical is load-bearing: a sparse file's meaning leans on the defaults reference, so a default that changes in a future schema version changes the file's effective meaning — the dependency the PRFAQ's versioned-defaults open question exists to manage. Subtracting any other baseline — a remote block against the merged base config — yields an overlay that is meaningful only relative to that baseline and is not a standalone config. At the type level, `SparseProjectConfig` is a deep-partial of `ProjectConfig` either way and must be re-decoded before use where a complete config is required.

Subtraction never recurses into `remotes` when the baseline is the default config: the default config has no remote blocks, so under subtract semantics user remote blocks survive untouched. Both operands must be *effective* configs — values in which every absence has already been resolved. A standalone-decoded `[remotes.*]` block is not one: decoding a sparse fragment materializes global defaults in every section it omitted, where the block meant to inherit from the base config. Subtracting such a block retains those materialized defaults wherever the base overrides the same field (base `db.port = 54399`, remote omits `db` → the decoded block carries the global default `54322`, which survives subtraction), and writing the overlay back flips the branch from inheriting the base's value to explicitly pinning the global default. **To sparsify a branch's config (CLI-2156/2064), subtract its merged effective config — the raw remote subtree merged over the raw base document *before* decoding, as `io.ts`'s `mergeRemoteSubtree` does precisely so remote schema defaults never leak in — against the base effective config, never the default config.**

All functions are pure and synchronous, operating on decoded config values, with no Effect in the public signature. Subtraction accepts the root-scope shape (`BaseProjectConfig`, a `ProjectConfig` without the nested `remotes`), keeping `remotes` out of its contract — an effective config translated from the Management API has no `remotes` of its own and still fits without a cast or a fabricated field.

## Rationale

- **One core instead of a cascade.** The merge-and-prune cascade sketched in CLI-2155's planning comment reduces algebraically to `subtract(merge(local, remote), defaults)`. Exporting the subtraction gives `config diff` and `config pull` the shared comparison core without binding this package to the Management API's response shape (translating that shape to `ProjectConfig` is CLI-2156's concern).
- **Defaults derived, not duplicated.** Every field's default already lives in the schema (`default` annotations plus `withDecodingDefaultKey`). Decoding `{}` materializes them; a parallel hand-written defaults object would drift.
- **Strict deep equality, array order matters.** Order is semantically load-bearing for values like `api.extra_search_path` (Postgres `search_path` resolution order). Treating reordered arrays as equal would prune values that behave differently from the default. The false-positive cost (a semantically-default-but-reordered array survives as harmless noise) is far cheaper than wrongly deleting meaningful config.
- **Dropping empty sections is lossless.** Every section carries a section-level decoding default, so an absent section and an empty section decode identically; empty carcass headers are pure diff noise.
- **Pure functions.** The subtraction has no failure channel, no resources, and no concurrency — the repo's Effect-native policy explicitly exempts such leaf primitives. Purity also keeps the module portable if the package later grows browser-compatible entry points.

## Consequences

### Positive

- Diffs and pulled configs contain only values that differ from their baseline.
- One walk implementation serves defaults-stripping and remote-block sparsification.
- Schema remains the single source of truth for defaults; changing a default in the schema changes the subtraction behavior with no second edit.
- A unit test pins the invariant that all schema defaults are mutually valid (decoding `{}` succeeds), so a conflicting default fails CI loudly.

### Negative

- Fields declared `optionalKey` without a `default` annotation can never be pruned; if a platform default exists for such a field, it must be added to the schema before subtraction can see it.
- A user's explicitly-written default value (`max_rows = 1000` typed by hand) is indistinguishable from an omitted one and will be pruned; intent is not preserved.
- Callers must know the remote-block rules, and neither is enforceable at the type level: the config operand must be the branch's *merged effective* config (a standalone-decoded `[remotes.*]` block materializes global defaults where it meant to inherit), and the baseline must be the merged base config, never the default config. Violating either reintroduces the silent branch-behavior change this ADR exists to prevent.
- `omitDefaultValues` output is sparse at the root scope only: record-keyed entries (`functions.*`, `remotes.*`) pass through whole with their per-entry decoding defaults materialized, since the default config's empty records offer no per-entry baseline. This cancels out in a diff (both sides carry the same materialized defaults), but a consumer rendering the sparse config directly must strip entry-level defaults itself, as the encoded write path does with `stripFunctionRecordDefaults`.

## Alternatives Considered

1. **Merge-and-prune cascade as a single function** (`(apiResponse, configToml) → massaged config`): binds `@supabase/config` to the Management API response shape and entangles this package with remote-to-local translation, which belongs to the diff core (CLI-2156).
2. **Recursing into `remotes` against global defaults**: looks obviously correct, is subtly wrong — pruning a remote's `api.max_rows = 1000` (global default) under a base that sets `500` changes the branch's effective value from 1000 to 500.
3. **Hand-written defaults reference object**: duplicates ~100 defaults already declared in the schema and drifts silently.
4. **Order-insensitive array comparison**: prunes reordered arrays whose order is semantically meaningful (`extra_search_path`).

## Related Decisions

- [ADR 0009](0009-configuration-schema-and-validation.md): Configuration Schema & Validation — the umbrella charter this decision answers a slice of (default config generation, `@supabase/config` package architecture)
- [ADR 0006](0006-environment-management.md): Environment Management — remote blocks and branch mapping semantics

## See Also

- [CLI-2155](https://linear.app/supabase/issue/CLI-2155/store-the-config-default-values-and-provide-mapping-function) — this ticket
- [CLI-2156](https://linear.app/supabase/issue/CLI-2156/add-supabase-config-diff-to-the-cli) — `config diff`, consumer of the subtract core
- [CLI-2064](https://linear.app/supabase/issue/CLI-2064/add-supabase-config-pull-to-the-cli) — `config pull`
