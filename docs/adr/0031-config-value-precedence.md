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
  returns a resolved config, memoised per workdir, project ref and flag set within a runtime. The resolved config
  decodes the whole config eagerly, so an invalid value fails every command that loads config
  unless the caller passes `tolerateInvalid`. Load-time warnings (an env value
  overriding a remote, the `[inbucket]` deprecation) print once per runtime, however many
  resolved configs it loads. Code that writes config or `.temp` goes through `writeThrough`, which drops
  the memo.
- The resolved config surface is:
  - `get(key)`: the value and the origin tier that supplied it.
  - `loaded`: what the project declares, with every flag, env and secret winner written in and no
    defaults. `fileDeclared`: what the config file alone declares, with `env()` resolved and no
    flag or `SUPABASE_*` overlay.
  - `materialized`: `loaded` plus defaults and normalizers, with `originAt(path)`. `origins`: the
    origin of every registry key.
  - `appliedRemote`, `hasConfigFile`, `declares(path)`, `familyNames(family)`, `invalid`,
    `withheldEnv`, `dotenvPrivateKeys`.
  - `envValues(names)`: the non-empty value of each named variable, shell before project `.env*`,
    for resolving `env(NAME)` references.
  - `projectEnvValues`: the raw project `.env*` record, for names outside the registry only (see
    the exceptions).
- The key registry is generated from `CliConfigSchema`. Each leaf gets a path, the env name
  `SUPABASE_` plus the upper-snake path, and a codec derived from its type. Hand-written
  annotations cover what the schema cannot express: codec overrides, secret
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
- Local SMTP is on when `[auth.email.smtp]` sets `enabled`, or when the table is present and
  leaves it out. The schema default alone is off, so a partial table such as one holding only
  `pass = "env(SMTP_PASS)"` still loads. `resolveSmtpEnabled` implements the rule for every
  reader, and `config push` and `config pull` see the same value.
- Exceptions kept on purpose:
  - `CommandSettings` reads `SUPABASE_PROJECT_ID` from the shell only, because it selects the
    target project before any config is loaded.
  - `resolveExperimentalFeature` ignores remotes and `.env`, because it runs before the target
    project is known.
  - `experimental.pgdelta` is exempt from section gating: `enabled` defaults to true, so the env
    rollback (`SUPABASE_EXPERIMENTAL_PGDELTA_ENABLED=false`) applies while the section is absent.
    `SUPABASE_EXPERIMENTAL_PG_DELTA` is not read.
  - `db.password` has no env tier: the local database password lives in config, and the linked
    password is a separate key with its own env name, flag and scoping.
  - Credential scoping covers the linked database password only. `SUPABASE_AUTH_SERVICE_ROLE_KEY`
    is not scoped to the linked project.
  - Flag ownership covers the names in `CLI_CONFIG_FLAGS` only. A command may declare any other
    flag, with or without a config key behind it.
  - `resolvedConfig.projectEnvValues` serves names outside the registry: Docker and registry resolution,
    the services hostname, Bitbucket detection, `SUPABASE_YES`, `SUPABASE_NETWORK_ID`, and the
    project env `functions serve` forwards to the edge runtime. A registry name read from it is a
    guard failure.
  - `secrets set` loads with `tolerateInvalid`, so an invalid value elsewhere in the config does
    not block setting secrets; it reads `edge_runtime` through `resolveCliSubtree`.
  - `--include-seed` beats `db.seed.enabled = false` in the base config; the flag is the
    highest tier for the decision it names.
  - `layeredParseEnv` in `db-config.parse.ts` looks up libpq `PG*` names, which are not registry
    keys, so it stays outside the registry.
  - The telemetry event catalog lists `SUPABASE_PROJECT_ID` as an environment signal; it records
    which variables are set and never resolves a value.
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

- Breaking changes, listed in the pull request: an invalid `SUPABASE_EXPERIMENTAL_STACK`
  value now fails, `--password` is rejected for commands that
  default to the local database, `db reset --linked` can ask a second prompt, an invalid config
  value fails every command that loads config, `services` and `functions` read `config.json`
  first, and `config push` pushes env-overridden values.
- The remote and credential rules are subtle enough that a reader must consult the resolved config's
  `origin` to know why a value won.

### Guardrails

- `code-structure.unit.test.ts` fails when:
  - a registry env name appears as a string literal outside the foundation files
    (`config/cli-config-*.ts`, `shared/config/cli-config-*.ts`), whatever the read pattern; only
    the telemetry event catalog is exempt;
  - the old overlay identifiers return;
  - a foundation file imports from `commands/` or `command-internal/`;
  - `CliConfigFlagInputs` is constructed outside `cli-config-flags.ts`;
  - a registry-backed flag is declared with a raw `Flag.*` instead of `key.flag`;
  - `process.env`, `Bun.env` or an aliased form is read outside the foundation, the entrypoint
    and `shared/compute/stacks/**` templates;
  - a file outside the foundation imports `loadCliConfig`, `resolveCliConfigSubtree` or
    `loadCliProjectEnvironment` from `@supabase/config`, tests included for the last.
- `oxlint` bans `process.env`, `Bun.env`, `globalThis.process`, `env` imported from `node:process`,
  `process` or `bun`, and namespace imports of `node:process` across `apps/cli/src`, except the
  config provider, the env loader, the entrypoint, `shared/compute/stacks/**` and tests. Importing
  `ambientEnvironment` is limited to nine audited files that read terminal, libpq, Docker and proxy
  variables, never a registry name: `cli/complete.ts`, `command-internal/colors.ts`,
  `command-internal/db-config.parse.ts`, `command-internal/hostname.ts`,
  `command-internal/pgpass.ts`, `commands/login/login-claude-hint.ts`,
  `commands/start/lib/env-or-default.ts`, `commands/start/services/vector.service.ts` and
  `shared/functions/deploy.ts`. A default-import alias of `node:process` is caught by the
  code-structure guard instead.
- `CliConfigFlagInputs` is not an allowed runtime service, so a command that reads config values
  without `withCliConfigFlags` fails `tsc`.
- Registry unit tests check env-name uniqueness, section gating, and that every
  schema leaf is in the registry or explicitly excluded.
- `cli-config-contract.unit.test.ts` walks every registry key and family field and checks that
  each resolves from the highest tier that can supply it, with that tier's origin, that a lower
  tier wins only when every higher one is unavailable, and that an empty shell variable falls
  through. It also pins secret keys and the declared flags to real keys.
- `cli-config-flag-ownership.unit.test.ts` walks the command tree, hidden commands included, and
  fails when a flag the registry owns is missing from a command, bound to another key, or bound by
  a command that does not declare it. It checks the names in `CLI_CONFIG_FLAGS` only.

### Adding a key or a flag

- A new `CliConfigSchema` leaf joins the registry automatically. Add an annotation only for a
  non-default codec, a secret, a section gate or an exclusion; a leaf with no codec must
  be listed in `CLI_CONFIG_SCHEMA_EXCLUDED` or registry construction throws.
- To bind a flag, add it to `CLI_CONFIG_FLAGS`, declare it with `key.flag` in the command, and
  pipe the command config through `withCliConfigFlags`.
- Read the value with `resolvedConfig.get(CliConfigKeys.<path>)`. Never read the env name directly.
- A new exception to any rule above is a decision: record it in this ADR and in the guard's
  exemption list together.

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
