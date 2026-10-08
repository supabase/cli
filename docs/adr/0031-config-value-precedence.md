# 0031. Config value precedence

**Status**: proposed
**Date**: 2026-10-08

## Problem Statement

Each command family read config values through its own overlay: the db reader, the start and stack
readers, `config push` and the telemetry gate each decided separately how flags, environment
variables, `.env` files, `[remotes.*]` blocks and `config.toml` combine. They disagreed. A matched
`[remotes.*]` block could beat an explicit `SUPABASE_*` variable, a variable could be honoured by
`db push` and ignored by `start`, and a project `.env` value reached some commands only.

## Decision

- Every config value resolves in one order: explicit flag, shell environment, project `.env*`
  files, config (`config.json` preferred over `config.toml`, a matched `[remotes.*]` block over the
  base document), default. One pure function, `pickCliConfigKey`, implements it, and the tier order
  is a constant.
- Commands read values through the `CliConfigValues` service. `load({ workdir, projectRef })`
  returns a snapshot, memoised per workdir, project ref and flag set within a runtime. The snapshot
  decodes the whole config eagerly, so an invalid value fails every command that loads config.
  `get(key)` returns the value and the tier it came from; `materialized` is the fully decoded
  config for consumers that need the whole object. Code that writes config or `.temp` goes through
  `writeThrough`, which drops the memo.
- The key registry is generated from `CliConfigSchema`. Each leaf gets a path, the env name
  `SUPABASE_` plus the upper-snake path, and a codec derived from its type. Hand-written
  annotations cover what the schema cannot express: deprecated env aliases, codec overrides, secret
  and section-gated keys, context defaults, exclusions and key families. Document-only keys such as
  `db.password` have no env tier.
- A flag binds to a key with `key.flag(...)`, declared in the annotations. The flag supplies the
  highest tier. `withCliConfigFlags` collects a command's bindings, and two flags assigning the
  same key fail with an error.
- Env for a section-gated key applies only when the section exists in the merged document, so
  `SUPABASE_AUTH_SMS_TWILIO_AUTH_TOKEN` does not conjure a provider block.
- Remote selection uses the effective `project_id` of each `[remotes.*]` block, which is
  `SUPABASE_REMOTES_<NAME>_PROJECT_ID` when set, else the TOML value.
- Credential scoping: an env source for a key marked `linkedTarget` (the linked database password)
  is withheld when the target project differs from the one in `.temp/project-ref`. This changes
  which sources are available, not the tier order. The CLI prints a notice naming the ignored
  variable; without a password it mints a temporary login role.
- Seed consent: when a target matches a `[remotes.*]` block, a matched block that does not declare
  `db.seed.enabled` seeds nothing by default. `db push` and `db reset --linked` ask before seeding
  into the matched project (`--yes` or `SUPABASE_YES` skips the prompt); a non-interactive run
  without `--yes` exits 1. `db push` still seeds only with `--include-seed`.
- Exceptions kept on purpose:
  - `CommandSettings` reads `SUPABASE_PROJECT_ID` from the shell only, because it selects the
    target project before any config is loaded.
  - `resolveExperimentalFeature` ignores remotes and `.env`, because it runs before the target
    project is known.
  - `db.password` has no env tier: the local database password lives in config, and the linked
    password is a separate key with its own env name, flag and scoping.
- The pipeline stages live in `@supabase/config/internal` and are not covered by semver. The CLI
  composes them: parse, merge a selected remote, overlay values, decode.

## Rationale

One implementation of the order removes the class of bug where two readers disagree. Generating
the registry from the schema means a new schema field gets an env override without a second edit.
Eager whole-config decode costs a failure on unrelated invalid values but makes every reader see
the same config. Credential scoping is source availability rather than a different order, so the
order stays the same for every key.

## Consequences

### Positive

- A flag, then env, then `.env`, then config, behaves identically across commands.
- A matched remote no longer shadows an explicit environment variable.
- Four more leaves are overridable from the environment: `auth.sms.otp_expiry`,
  `auth.sms.otp_length`, `db.network_restrictions.allowed_cidrs` and
  `db.network_restrictions.allowed_cidrs_v6`.

### Negative

- Breaking changes, listed in the pull request: invalid `SUPABASE_EXPERIMENTAL_PG_DELTA` or
  `SUPABASE_EXPERIMENTAL_STACK` values now fail, `--password` is rejected for commands that
  default to the local database, `db reset --linked` can ask a second prompt, an invalid config
  value fails every command that loads config, `services` and `functions` read `config.json`
  first, and `config push` pushes env-overridden values.
- The remote and credential rules are subtle enough that a reader must consult the snapshot's
  `origin` to know why a value won.

### Guardrails

- `code-structure.unit.test.ts` fails when a registry env name appears in a read position outside
  the foundation files (`config/cli-config-*.ts`, `shared/config/cli-config-*.ts`), when the old
  overlay identifiers return, when a foundation file imports from `commands/` or
  `command-internal/`, when `CliConfigFlagInputs` is constructed outside `cli-config-flags.ts`, or
  when a registry-backed flag is declared with a raw `Flag.*` instead of `key.flag`.
- `oxlint` bans `process.env` and `Bun.env` across `apps/cli/src`, except the config provider, the
  env loader, the entrypoint and stack code.
- `CliConfigFlagInputs` is not an allowed runtime service, so a command that reads config values
  without `withCliConfigFlags` fails `tsc`.
- Registry unit tests check env-name uniqueness, alias resolution, section gating, and that every
  schema leaf is in the registry or explicitly excluded.

### Adding a key or a flag

- A new `CliConfigSchema` leaf joins the registry automatically. Add an annotation only for a
  non-default codec, an alias, a secret, a section gate or an exclusion; a leaf with no codec must
  be listed in `CLI_CONFIG_SCHEMA_EXCLUDED` or registry construction throws.
- To bind a flag, add it to `CLI_CONFIG_FLAGS`, declare it with `key.flag` in the command, and
  pipe the command config through `withCliConfigFlags`.
- Read the value with `snapshot.get(CliConfigKeys.<path>)`. Never read the env name directly.

## Alternatives Considered

1. **Fix each reader to match the others**: keeps the duplicated overlays, so they drift again.
2. **Let remotes override env**: matches the old db behaviour but makes an explicit variable
   unable to win over a file.
3. **Reorder tiers for credentials**: hides the order behind per-key exceptions; scoping the
   sources keeps one order.

## Related Decisions

- [ADR 0020](0020-config-naming-vocabulary.md): the config vocabulary this decision uses.
- [ADR 0021](0021-projectconfig-convergence-semantics.md): the hosted subset that shares the schema.

## See Also

- [CLI config loading](../../packages/config/docs/cli-config-loading.md)
- [`apps/cli` agent rules](../../apps/cli/AGENTS.md)
