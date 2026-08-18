# Supabase CLI

The Supabase CLI and its supporting packages, including `@supabase/config` — the schema and tooling for the `config.toml` project configuration file that config-driven development (diff/pull/push) is built on.

## Language

### Project configuration

**Default config**:
The `ProjectConfig` in which every value carries its schema-declared default — what a project means before anyone configures anything.
_Avoid_: defaults reference, base config

**Sparse config**:
A partial config overlay containing only values that differ from some baseline. When the baseline is the default config it is itself a valid config that re-decodes to the same effective config under the current schema's defaults; against any other baseline it is meaningful only relative to that baseline.
_Avoid_: minimal config, pruned config, massaged config

**Subtract**:
The directional operation `config − baseline` that produces a sparse config: remove every value deep-equal (order-sensitive) to the baseline's, then drop sections left empty.
_Avoid_: prune, strip, massage

**Remote block**:
A `[remotes.<label>]` section declaring config overrides for a specific persistent Supabase branch — the branch's project ref in `project_id` binds the block (the label is a user-chosen alias), and unspecified options inherit from the base config. Its baseline is the merged base config, never the default config.
_Avoid_: environment block, branch config

**Base config**:
The root-scope fields of a `config.toml`, before any remote block is overlaid.

**Drift**:
A difference between a project's effective remote configuration and the local config file.
