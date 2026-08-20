# 0019. Config Diff Classification and Managed Surface

**Status**: proposed
**Date**: 2026-08-20

## Problem Statement

`supabase config diff` (CLI-2156) compares the local `config.toml` against the effective configuration `GET /v2/projects/{ref}/config` reports, and `config pull` (CLI-2064) will delegate to the same engine. Three classification problems make a naive walk wrong:

1. **Key-set asymmetry.** The earlier POC walked only keys present in the remote response, so a property the file declares and the remote doesn't return was structurally invisible. The inverse walk (local keys only) would hide remote-side drift the file never mentions.
2. **Managed vs. unmanaged.** Most of `config.toml` configures the *local* stack — `[studio]`, ports, image pins, `[db.migrations]` — and has no platform counterpart. Reporting those as drift is noise; deciding which properties the platform manages needs a source of truth that cannot drift from the code that reads the response.
3. **Incomparable values.** The platform masks secrets (HMAC, never plaintext), reports byte counts where the file writes `"50MiB"`, comma-joins arrays, and types some scalars differently than the schema. Comparing representations instead of meanings misreports drift; silently skipping them misreports cleanliness.

## Decision

`@supabase/config` owns the whole comparison core as pure, synchronous functions (`config-diff*.ts`), with no dependency on `@supabase/api`, output formatting, or command flags:

- **The managed surface is defined by the translation table.** `MANAGED_CONFIG_PROPERTIES` is a table of entries, one per local schema path the v2 resource can report, each carrying a `read` function that descends the structurally-typed response (`RemoteProjectConfig`, all six blocks as loose records) and coerces the wire value to the local schema's type. A schema path with no entry is *unmanaged by construction* — the managed set and the response-reading code are the same artifact and cannot drift apart. The auth table is ported from the Go CLI's `FromRemoteAuthConfig` (commit `7b469f5b3`), including its inversions (`enable_signup` ← `!disable_signup`), duration/enum transforms, and provider fan-out.
- **Four-way classification per managed path**, driven by *declared* presence (the raw pre-decode document) on the local side and `read` presence on the remote side: `update` (declared + returned, values differ), `remote_only` (returned, undeclared, and differing from the baseline default — equal-to-default values are suppressed, which is what CLI-2155's defaults reference exists for), `local_only` (declared, not returned — parsed-but-never-pushed attributes and permission-truncated responses), and unmanaged (never reported). The local operand follows ADR 0018: the branch's merged effective config when the target ref matches a `[remotes.*]` block's `project_id`, the base config otherwise.
- **Equality is meaning-based**: arrays compare as multisets, scalars tolerate string/number and string/boolean representation skew, and per-entry `normalize` hooks canonicalize (byte sizes via `RAMInBytes` semantics, Go-duration strings) before comparison while reported values stay un-normalized.
- **Secrets are "present, unknown".** Entries marked `secret` (the union of the schema's `x-secret` fields and Go's `Secret` machinery) are never compared and never counted; locally-declared ones are surfaced in `ConfigChangeSet.masked` so a clean change list is visibly a partial claim. Likewise `scope` records which blocks the response actually carried, so partially-populated responses degrade to `local_only` + an explicit scope note instead of an error or silent omission.
- The interpolation pipeline records the resolving env var name on `"environment"` value origins, so a change on an `env()`-fed property can name the variable involved.

The command layer (`apps/cli/src/legacy/commands/config/diff/`) only resolves the target, fetches, and renders.

## Considered Alternatives

1. **Derive the managed set from the response keys** (the POC's approach): whatever the remote returns is what's compared. Structurally blind to `local_only`, and a permission-truncated response silently shrinks the comparison.
2. **Schema annotations (`x-managed`) on each property**: keeps the knowledge in the schema, but the annotation and the response-reading code can disagree, and the annotation cannot express per-property wire transforms (comma-splits, inversions, unit conversions) that the table entry's `read` carries anyway.
3. **Reuse `config push`'s `config-sync` diffing** (`apps/cli/src/legacy/commands/config/push/config-sync/`): those helpers produce per-service unified-diff *text* against the v1 per-service endpoints for push previews, not a typed change set, and they live in the CLI app. They remain the Go-parity push path; the classification core is the reusable engine `pull` needs. Consolidating push onto the core is possible later but out of scope here.

## Consequences

- `config pull` gets its comparison engine for free: the change set is typed data, and the same translation produces the local representation of any remote value it needs to write.
- Adding a newly platform-managed property is one table entry; forgetting it means the property is silently unmanaged (never misreported as drift), which fails safe.
- The structural `RemoteProjectConfig` type mirrors the v2 wire shape; if the API reshapes a block, the readers' runtime guards degrade to "not returned" (`local_only`/silent) rather than crashing, and the live test is the tripwire.
- Platform defaults that diverge from schema defaults surface as `remote_only` drift by design — the file's meaning is defined by the schema defaults reference (ADR 0018), not by what the platform would have picked.

## Related Decisions

- [ADR 0018](0018-sparse-config-subtraction.md): Sparse Config Subtraction — the defaults baseline and merged-remote-block local operand this classification builds on.
- [ADR 0006](0006-environment-management.md): Environment Management — remote blocks and branch mapping semantics.
