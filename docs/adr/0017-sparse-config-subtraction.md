# 0017. Sparse Config Subtraction

**Status**: proposed
**Date**: 2026-08-14

## Problem Statement

`config diff` (CLI-2156) and `config pull` (CLI-2064) compare a project's remote configuration against the local `config.toml`. The remote endpoint (`GET /v2/projects/{ref}/config`) returns the *effective* config — every setting reported, defaulted or not — and a locally decoded `ProjectConfig` likewise has every default filled in. Comparing these full objects directly would drown the user in hundreds of identical default values. CLI-2155 asks for a stored reference of config defaults and a mapping function that omits values matching them, so diffs stay readable and pulled files stay sparse.

The trap is where that mapping recurses. A `[remotes.<label>]` block is itself a sparse overlay whose meaning is "override the merged base config here". A value in a remote block that happens to equal a *global default* is not redundant: if the base config overrides the same property, removing the remote's value silently changes what that branch resolves to.

## Decision

`@supabase/config` exports a pure, parameterized subtraction core:

- `getDefaultProjectConfig()` — the default config, derived by decoding `{}` through `ProjectConfigSchema` (memoized). The schema's `default` annotations and decoding defaults are the single source of truth; no hand-maintained defaults table exists.
- `subtractProjectConfig(config, baseline)` — returns the sparse config `config − baseline`: every value strictly deep-equal (order-sensitive) to the baseline's is removed, then sections left empty are dropped recursively.
- `omitDefaultValues(config)` — `subtractProjectConfig` with the default config as baseline.

Subtraction never recurses into `remotes` when the baseline is the default config: the default config has no remote blocks, so under subtract semantics user remote blocks survive untouched. **The correct baseline for a remote block is the merged base config, never the default config.** Callers that want to sparsify a remote block (CLI-2156/2064) must call `subtractProjectConfig(remoteBlock, mergedBaseConfig)` explicitly.

All functions are pure and synchronous, operating on decoded `ProjectConfig` values, with no Effect in the public signature.

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
- Callers must know the remote-block baseline rule; misusing the default config as a remote block's baseline reintroduces the override-erasure bug this ADR exists to prevent.

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
