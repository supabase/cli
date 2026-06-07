# Environments Management — Design Document

## Overview

Environments provide a way to manage sets of environment variables and secrets for different stages of a project's lifecycle. They are the mechanism through which configuration values in `config.json` are resolved at runtime, both locally and on the platform.

This document covers the data model, CLI commands, resolution logic, and the workflows for both remote-first and local-first development modes.

---

## Core Concepts

### What Is an Environment?

An environment is a named collection of key-value pairs (environment variables) stored on the platform. Each variable belongs to exactly one environment. There is no inheritance between environments — each is an independent, flat set of variables.

### Default Environments

Every project is created with two branches (`main` and `dev`) and three environments:

| Environment   | Purpose                                                                                                                               | Mapped to                                                          |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `development` | Local development via `cli dev`. Contains values that work on a developer's machine (localhost URLs, local database, debug settings). | Not mapped to a branch — mapped to local execution.                |
| `preview`     | Deployed preview environments. Contains values for hosted preview infrastructure.                                                     | `dev` branch and all other non-production branches (via wildcard). |
| `production`  | Live, user-facing deployment. Starts empty and is populated when the project is ready to go live.                                     | `main` branch.                                                     |

All three default environments cannot be deleted or renamed.

The key distinction: `development` is for running locally, `preview` is for deploying remotely. A developer on the `dev` branch uses `development` variables when running `cli dev` on their machine, and `preview` variables when their code is deployed as a preview on the platform.

### What Is a Project Branch?

A project branch is a forked copy of the project's infrastructure running independently on its own URL. It is a first-class platform concept — not a Git concept. There are three ways a project branch gets created:

- **From the dashboard** — the user creates a branch directly in the platform UI. No Git involvement.
- **Via GitHub integration** — a Git branch push triggers the creation of a corresponding project branch (named the same by default) through GitHub webhooks.
- **From the CLI** — the user creates a project branch directly via CLI commands.

We intend to have the `cli dev` command sync project branch creation and environment switching to the local Git workflow in remote-first dev mode, so that switching Git branches locally would automatically activate the corresponding project branch and reload the environment. The details of this behavior are still being finalized.

Every project starts with two project branches: `main` and `dev`.

### Custom Environments

Users can create additional environments (e.g., `staging`, `qa`, `testing`) for specialized workflows. Custom environments behave identically to the defaults — they are independent sets of variables with no special relationship to other environments.

### Branch-to-Environment Mapping

Each project branch resolves to a single _deployed_ environment. The mapping is configured in `config.json`:

```
{
  "environments": {
    "production": "main",
    "preview": "*"
  }
}
```

This is the default configuration for new projects. The `dev` project branch (and any other non-production branch) maps to `preview` via the wildcard. Users can add custom mappings as the project grows:

```
{
  "environments": {
    "production": "main",
    "staging": "staging",
    "preview": "*"
  }
}
```

The key is the environment name, the value is the project branch name or `"*"` for the wildcard (catch-all). The wildcard entry defines the default environment for any project branch not explicitly listed. If no wildcard is defined, unmapped branches fall back to `preview`.

The mapping is evaluated top-to-bottom; first explicit match wins, wildcard is always last. A project branch can only map to one environment.

**Note:** `development` does not appear in the branch mapping. It is not a deployment target — it is exclusively for local execution via `cli dev`.

---

## Platform Variables vs User Variables

Environment variables fall into two categories. Both live in the same environment, use the same CLI commands, and appear in the same dashboard — the difference is in how they are created and referenced in config.

### Platform Variables (implicit binding)

The platform knows its own config schema. Every config key that requires a secret or environment-specific value has a canonical environment variable name derived from the config path. For example:

| Config path                      | Canonical variable                        |
| -------------------------------- | ----------------------------------------- |
| `auth.external.google.client_id` | `SUPABASE_AUTH_EXTERNAL_GOOGLE_CLIENT_ID` |
| `auth.external.google.secret`    | `SUPABASE_AUTH_EXTERNAL_GOOGLE_SECRET`    |
| `db.pooler.default_pool_size`    | `SUPABASE_DB_POOLER_DEFAULT_POOL_SIZE`    |

The user does not need to write `env()` for these. The config block simply declares the feature:

```
{
  "auth": {
    "external": {
      "google": {
        "enabled": true
      }
    }
  }
}
```

The platform knows that enabling Google auth requires `SUPABASE_AUTH_EXTERNAL_GOOGLE_CLIENT_ID` and `SUPABASE_AUTH_EXTERNAL_GOOGLE_SECRET`, and resolves them from the environment automatically.

#### Scaffolding on feature activation

When a feature is enabled (via the dashboard or the CLI), the platform automatically creates the required variables as empty entries in the current environment, with the appropriate type (standard or secret). The CLI prompts the user to fill them in:

```
Google OAuth requires 2 variables:

  SUPABASE_AUTH_EXTERNAL_GOOGLE_CLIENT_ID
  Value: 1234567890.apps.googleusercontent.com ✓

  SUPABASE_AUTH_EXTERNAL_GOOGLE_SECRET
  Value (hidden): ••••••••••••• ✓
  Stored as secret.

✓ Added to "development" environment.
```

#### Missing variable warnings

When the CLI encounters an enabled feature with missing variables (e.g., during `cli dev`), it warns with actionable guidance:

```
Warning: auth.external.google is enabled but missing required variables:
  SUPABASE_AUTH_EXTERNAL_GOOGLE_CLIENT_ID
  SUPABASE_AUTH_EXTERNAL_GOOGLE_SECRET

Set them with:
  cli env set SUPABASE_AUTH_EXTERNAL_GOOGLE_CLIENT_ID "your-value" --env development
  cli env set SUPABASE_AUTH_EXTERNAL_GOOGLE_SECRET "your-value" --env development --secret

Or add them to supabase/.env.local for local development.
```

#### Sensitive fields cannot be hardcoded

The platform schema marks certain config fields as sensitive (e.g., `auth.external.google.secret`, any field containing keys, tokens, or passwords). These fields **must** come from an environment variable — either via implicit binding or explicit `env()` reference. If the CLI detects a raw value in a sensitive field, it fails with a clear error:

```
Error: auth.external.google.secret is a sensitive field and cannot be hardcoded in config.json.

Set it with:
  cli env set SUPABASE_AUTH_EXTERNAL_GOOGLE_SECRET "your-value" --env development --secret

Or add it to supabase/.env for local development:
  SUPABASE_AUTH_EXTERNAL_GOOGLE_SECRET=your-value
```

This prevents accidental secret leaks through `config.json`, which is committed to Git. All secrets live in `.env` files (gitignored) or on the platform.

Non-sensitive fields can be hardcoded in config normally:

```
{
  "db": {
    "pooler": {
      "default_pool_size": 10
    }
  }
}
```

For non-sensitive fields, the user has three options:

- **Hardcode in config** — `"default_pool_size": 10`. Simple, committed to Git, works everywhere.
- **Implicit binding** — omit the value, the platform resolves from `SUPABASE_DB_POOLER_DEFAULT_POOL_SIZE` if set in the environment.
- **Explicit** `env()` — `"default_pool_size": "env(MY_POOL_SIZE)"` for cases where the value should vary per environment.

#### Resolution precedence for platform variables

For a platform config value like `auth.external.google.secret`, the resolved value is determined by (first match wins):

1. **Canonical environment variable** (`SUPABASE_AUTH_EXTERNAL_GOOGLE_SECRET`) resolved via the standard resolution chain (OS env → `.env.local` → `.env`).
2. `env()` override in config — if the user writes `"secret": "env(MY_CUSTOM_NAME)"`, that variable name is used instead of the canonical one (see below).

If none of the above produce a value and the feature is enabled, the CLI warns about the missing variable.

### User Variables (`env()` syntax)

For values the platform doesn't know about — third-party service keys, application-specific config, custom feature flags — the user explicitly references environment variables using the `env()` syntax in config:

```
{
  "functions": {
    "my-function": {
      "env": {
        "OPENAI_API_KEY": "env(OPENAI_API_KEY)",
        "FEATURE_FLAG_V2": "env(FEATURE_FLAG_V2)"
      }
    }
  }
}
```

The user controls the naming and is responsible for setting these values in the environment.

### Overriding canonical names with `env()`

In rare cases, a user may want a platform config key to read from a non-canonical variable name. The `env()` syntax serves as an escape hatch:

```
{
  "auth": {
    "external": {
      "google": {
        "enabled": true,
        "client_id": "env(MY_GOOGLE_ID)",
        "secret": "env(MY_GOOGLE_SECRET)"
      }
    }
  }
}
```

This overrides the implicit binding — the platform will look for `MY_GOOGLE_SECRET` instead of `SUPABASE_AUTH_EXTERNAL_GOOGLE_SECRET`. Most users will never need this.

### How platform and user variables appear in `.env`

When running `cli env pull`, both types appear in the same file, grouped for clarity:

```
# Pulled from "development" environment

# auth.external.google
SUPABASE_AUTH_EXTERNAL_GOOGLE_CLIENT_ID=1234567890.apps.googleusercontent.com

# Secrets excluded: SUPABASE_AUTH_EXTERNAL_GOOGLE_SECRET

# User variables
OPENAI_API_KEY=sk-abc123
FEATURE_FLAG_V2=true
```

### Summary of variable binding modes

| Mode                                     | Config example                                                            | When to use                                 |
| ---------------------------------------- | ------------------------------------------------------------------------- | ------------------------------------------- |
| **Hardcoded (non-sensitive only)**       | `"default_pool_size": 10`                                                 | Static config values safe to commit to Git  |
| **Implicit (recommended for sensitive)** | `"enabled": true` + values in environment under canonical names           | Standard workflow — zero config boilerplate |
| **Explicit** `env()`                     | `"secret": "env(CUSTOM_NAME)"` + values in environment under custom names | Edge cases requiring non-canonical names    |

---

## Variable Types

Every variable is encrypted at rest on the platform. There is no separate "secrets" storage — all variables live in the same system. The distinction is a flag on the variable, not a separate mechanism.

### Standard Variables

- Can be read, written, listed, and pulled.
- Visible in the dashboard and via `cli env list`.
- Included when running `cli env pull`.

### Secret Variables

- Write-only after creation. The value cannot be read back from the dashboard, the API, or the CLI.
- `cli env list` displays the key but shows `[secret]` as the value.
- **Excluded from** `cli env pull` — they never land in a local `.env` file automatically.
- Useful for production API keys, signing keys, and other high-sensitivity values.

A variable is marked as secret at creation time and cannot be converted back to standard. To "unsecret" a variable, delete it and recreate it as standard. Secrets are created through:

- **`cli env set --secret`** — explicitly marks a variable as secret when setting it.
- **Interactive seeding** — when seeding one environment from another, variables that are already secret in the source remain secret in the target.
- **Schema auto-classification** — for platform variables, the CLI auto-classifies based on `"x-secret": true` in the config schema (e.g., `auth.external.google.secret` is automatically created as a secret).

There is no file-based annotation or interactive prompt during push. Secrets should never flow through `.env` files — they are set directly on the platform via `cli env set --secret` or through the dashboard.

---

## Local File Structure

```
supabase/
├── config.json          # project configuration, uses env() and implicit bindings
├── .env                 # pulled from "development" environment, gitignored
├── .env.local           # personal overrides, gitignored, never synced
└── .gitignore           # includes .env*
```

All `.env*` files are gitignored. There is only ever one `.env` file — it represents a snapshot of the `development` environment (or whichever environment was explicitly pulled). There are no `.env.production`, `.env.preview`, etc. files sitting on disk.

### `.env`

The working environment file. It is either:

- Generated by `cli env pull` (remote-first) — defaults to pulling from `development`, or
- Created and maintained manually by the user (local-first).

### `.env.local`

Personal overrides that are never pushed to the platform and never shared with teammates. This is where a developer puts truly machine-specific values. With the `development` environment providing team-agreed local defaults, `.env.local` should rarely be needed — it's for edge cases like a personal API key or a non-standard local port.

---

## Resolution Order

Resolution differs between local development and deployed environments.

### Local development (`cli dev`)

When the CLI encounters `env(DATABASE_URL)` in `config.json` or resolves a platform variable, the value is determined by (first match wins):

1. **OS environment variables** — so CI/CD pipelines, Docker, and shell overrides work naturally.
2. `.env.local` — personal overrides, never synced.
3. `.env` — pulled from the `development` environment or manually maintained.

### Deployed environments (platform)

On the platform, local files are not involved. The resolution is:

1. **Branch-specific override** for the variable in the mapped environment (if one exists for the current branch).
2. **Base environment variable** in the mapped environment.

### Complete resolution diagram

```
┌─────────────────────────────────────────────────────────────────┐
│  LOCAL DEVELOPMENT (cli dev)                                    │
│                                                                 │
│  config.json                                                    │
│    auth.external.google.secret                                  │
│       │                                                         │
│       ▼                                                         │
│  ┌─ Canonical variable: SUPABASE_AUTH_EXTERNAL_GOOGLE_SECRET    │
│  │  (or env() override, or hardcoded value in config)           │
│  │                                                              │
│  │  Resolved via:                                               │
│  │    1. OS environment ─── e.g. export in shell                │
│  │    2. .env.local ─────── personal overrides (rare)           │
│  │    3. .env ───────────── pulled from "development"           │
│  │                                                              │
│  └─ Final value                                                 │
└─────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────┐
│  DEPLOYED (platform)                                            │
│                                                                 │
│  Project branch: feature-x  →  Environment: preview             │
│                                                                 │
│  SUPABASE_AUTH_EXTERNAL_GOOGLE_SECRET                           │
│    1. Branch override (feature-x) ─── if exists                 │
│    2. Base value (preview) ────────── fallback                  │
│                                                                 │
│  Final value injected at runtime                                │
└─────────────────────────────────────────────────────────────────┘
```

### How the three environments relate

```
┌─────────────────────────────────────────────────────────────────────┐
│                                                                     │
│   development          preview               production             │
│   ┌───────────┐        ┌───────────┐         ┌───────────┐         │
│   │ localhost  │        │ hosted    │         │ live      │         │
│   │ URLs       │        │ preview   │         │ user-     │         │
│   │ debug keys │        │ infra     │         │ facing    │         │
│   │ test data  │        │ URLs      │         │ values    │         │
│   └─────┬─────┘        └─────┬─────┘         └─────┬─────┘         │
│         │                    │                      │               │
│         ▼                    ▼                      ▼               │
│     cli dev              deployed               deployed            │
│     (local machine)      previews               to production       │
│                          (dev branch,            (main branch)       │
│                          feature branches,                          │
│                          dashboard branches)                        │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
```

---

## CLI Commands

### Environment CRUD

```
# List all environments for the current project
cli env list-environments

# Create a custom environment, optionally seeding it from an existing one
cli env create <n> [--from <source_environment>]

# Seed with interactive review (see below)
cli env create <n> --from <source_environment> --interactive

# Delete a custom environment (production, preview, development cannot be deleted)
cli env delete <n>

# Seed an existing environment from another (e.g., populating production from preview)
cli env seed <target> --from <source> [--interactive]
```

`cli env create --from` and `cli env seed --from` both support seeding, but serve different purposes: `create` makes a new environment and optionally seeds it, while `seed` populates an existing environment (such as the default `production` which already exists but starts empty).

#### Interactive seeding

When seeding one environment from another, values often need to change — a development database URL is not the same as a production one. The `--interactive` flag (also available in the dashboard) walks the user through each variable:

```
Seeding "production" from "preview" (14 variables):

  DATABASE_URL = "postgres://preview-db:5432/app"
  [K]eep / [E]dit / [S]kip? e
  New value: postgres://prod-db:5432/app ✓

  API_ENDPOINT = "https://api.preview.example.com"
  [K]eep / [E]dit / [S]kip? e
  New value: https://api.example.com ✓

  LOG_LEVEL = "debug"
  [K]eep / [E]dit / [S]kip? e
  New value: warn ✓

  STRIPE_KEY = [secret]
  [E]nter new value / [S]kip? e
  New value (hidden): ••••••••••••• ✓
  Stored as secret.

  ANALYTICS_ID = "UA-12345"
  [K]eep / [E]dit / [S]kip? k ✓

  ... (9 more)

Created "production" with 13 variables (1 skipped).
```

For secret variables from the source environment, the value cannot be displayed or copied — the user must enter a new value or skip the variable entirely.

Without `--interactive`, all variables are copied as-is (secrets included) and the user can edit them afterward with `cli env set`. This is useful for environments that share most values with the source (e.g., a `staging` environment seeded from `preview`).

### Variable Management

All variable management commands operate directly on the platform. They require a linked project.

```
# Set a variable on a specific environment
cli env set <KEY> <value> --env <environment>
cli env set <KEY> <value> --env <environment> --secret

# Set a branch-specific override
cli env set <KEY> <value> --env <environment> --branch <branch>

# Unset (delete) a variable
cli env unset <KEY> --env <environment>
cli env unset <KEY> --env <environment> --branch <branch>

# List all variables for an environment (includes branch overrides)
cli env list --env <environment>
```

If `--env` is omitted, the CLI defaults to:

- `development` when running locally (no deployment context).
- The active environment based on the current branch mapping when a deployment context is available.

If the project is not linked, the command fails with an error.

### Pull (Platform → Local)

```
# Pull the development environment (default for local work)
cli env pull

# Pull a specific environment
cli env pull --env <environment>
```

Behavior:

- **Defaults to** `development` when no `--env` is specified. This is the expected workflow — developers pull the `development` environment for local work.
- Writes/overwrites `supabase/.env` with the resolved set of standard variables.
- When pulling a deployed environment (`preview`, `production`, or custom), branch-specific overrides for the current branch are resolved — the `.env` file contains final values, not layers.
- Secret variables are excluded. A comment is appended listing the excluded secret keys so the developer knows what to add in `.env.local`:

  ```
  # Pulled from "development" environment
  #
  # Secrets excluded (add to .env.local if needed):
  #   SUPABASE_AUTH_EXTERNAL_GOOGLE_SECRET
  #   STRIPE_KEY

  # auth.external.google
  SUPABASE_AUTH_EXTERNAL_GOOGLE_CLIENT_ID=1234567890.apps.googleusercontent.com

  # User variables
  DATABASE_URL=postgres://localhost:5432/app
  API_URL=http://localhost:3000
  FEATURE_FLAG_V2=true

  ```

- If `supabase/.env` already exists, it is overwritten without merge. Pull is a full replacement.

### Push (Local → Platform)

```
# Push .env contents to the development environment (default)
cli env push

# Push to a specific environment
cli env push --env <environment>

# Push from a specific file
cli env push --file .env.staging --env staging

# Push without confirmation prompt
cli env push --env development --yes

# Show what would change without applying
cli env push --env development --dry-run

# Remove remote variables not present in the local file
cli env push --env development --prune
```

Behavior:

1. Parse the local `.env` file (or the file specified with `--file`).
2. Fetch the current base variables for the target environment from the platform.
3. Compute a diff and display it:

   ```
   Pushing to "development" environment:

     + NEW_VAR = "hello"                (add)
     ~ DATABASE_URL = "postgres://…"    (changed)
     = API_ENDPOINT                     (unchanged, skipped)
     ! STRIPE_KEY                       (secret on remote, skipped)
     - OLD_VAR                          (remove, only with --prune)

   2 additions/changes, 1 removal, 1 secret skipped. Continue? [y/N]

   ```

4. On confirmation, send a single bulk upsert request to the platform API.

Design decisions:

- **Push defaults to** `development` when no `--env` is specified, matching pull behavior.
- **Push always operates on base values.** Branch-specific overrides cannot be set via push — they must be set individually with `cli env set --branch`. This prevents accidentally turning base values into branch-scoped ones.
- **Without** `--prune`, push only adds and updates — it never deletes remote variables. This is the safe default.
- **With** `--prune`, variables present on the remote but absent from the local file are deleted. The diff clearly shows removals before confirmation.
- **Variables marked as `secret` on the remote are skipped entirely.** The diff shows `! KEY (secret on remote, skipped)`. Push never overwrites secrets — to update a secret, use `cli env set --secret`.
- **New variables added via push are always created as standard.** To create a secret, use `cli env set --secret` directly.
- `.env.local` is never pushed. Only `.env` (or the file specified with `--file`) is used as the source.

---

## Branch-Specific Overrides

A variable within a deployed environment (`preview`, `production`, or custom) can optionally have overrides scoped to a specific project branch. The base value applies to all project branches mapped to that environment, and a branch override takes precedence for a specific project branch only. This avoids creating a full custom environment when only a few values need to differ.

Each override is scoped to a single project branch. If the same override is needed on multiple branches, it must be set separately for each.

**Note:** Branch-specific overrides do not apply to the `development` environment, since it is not mapped to any project branch.

### Example

A team has three project branches all mapping to `preview`. Two of them need a different API endpoint:

```
# Base value — applies to all project branches mapped to preview
cli env set API_URL "https://preview.example.com" --env preview

# Project branch-specific overrides
cli env set API_URL "https://feature-x.example.com" --env preview --branch feature-x
cli env set API_URL "https://feature-y.example.com" --env preview --branch feature-y
```

The third project branch (`feature-z`) gets the base value automatically.

### Listing with overrides

```
preview environment:

  API_URL          = "https://preview.example.com"
    └─ feature-x   = "https://feature-x.example.com"
    └─ feature-y   = "https://feature-y.example.com"
  DATABASE_URL     = "postgres://preview-db:5432/app"
  STRIPE_KEY       = [secret]
```

### Pull behavior

`cli env pull --env preview` resolves the correct value for the current project branch. If the current project branch is `feature-x` and a branch override exists for `API_URL`, the pulled `.env` contains the override value. The user doesn't need to think about layering — the pulled file always contains final resolved values.

### Push behavior

`cli env push` sets base values only. Branch-specific overrides must be set individually with `cli env set --branch`.

### Removing overrides

```
# Remove a project branch-specific override (the base value remains)
cli env unset API_URL --env preview --branch feature-x
```

### When to use overrides vs custom environments

| Scenario                                                                   | Recommendation                         |
| -------------------------------------------------------------------------- | -------------------------------------- |
| A project branch needs 1–3 different values                                | Branch-specific override               |
| A long-lived project branch (staging, QA) needs a broadly different config | Custom environment                     |
| A developer needs machine-specific overrides                               | `.env.local` (no platform involvement) |

---

## Workflows

### Remote-First (Linked Project)

This is the standard workflow when the user has an existing project on the platform.

```
┌──────────────────────────────────────────────────────────────────┐
│  Platform (source of truth)                                      │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐             │
│  │ development  │  │ preview     │  │ production  │  ···        │
│  │ DB=local     │  │ DB=preview  │  │ DB=prod     │             │
│  │ API=local    │  │ API=prev    │  │ API=prod    │             │
│  └──────┬──────┘  └─────────────┘  └─────────────┘             │
│         │                                                        │
└─────────┼────────────────────────────────────────────────────────┘
     cli env pull (default)
          │
          ▼
┌──────────────────────────────────────────────────────────────────┐
│  Local                                                           │
│  supabase/.env          (pulled from development)                │
│  supabase/.env.local    (personal overrides, rarely needed)      │
│                                                                  │
│  cli dev  →  reads .env.local → .env → runs local services       │
└──────────────────────────────────────────────────────────────────┘
```

Typical day-to-day:

1. `cli env pull` to get the latest `development` variables.
2. `cli dev` — everything works with localhost values. No overrides needed for most developers.
3. If a variable needs to change for the team, use `cli env set` to update it in `development`, or edit `.env` and `cli env push`.
4. Deployed previews and production use their own environments — no interaction with local files.

### Local-First (No Linked Project)

The user is working locally without a hosted project. The platform is not involved yet.

```
┌─────────────────────────────────────────────┐
│  Local only                                 │
│  supabase/.env          (manually created)  │
│  supabase/.env.local    (personal overrides)│
│  supabase/config.json   (uses env() syntax) │
└─────────────────────────────────────────────┘
```

Everything works except platform sync:

- `env()` resolves from `.env.local` → `.env` → OS environment.
- `cli dev` runs services with the correct variables.
- `cli env pull` / `cli env push` / `cli env set` fail with: `Error: No linked project. Run "cli link" first.`
- `cli env list-environments`, `cli env create`, `cli env delete` also fail (environments are a platform concept).

### Transitioning from Local-First to Remote-First

When the user links or deploys for the first time:

```
cli link          # or cli deploy
```

1. The CLI detects an existing `supabase/.env` file.
2. It prompts:

   ```
   Found local environment variables in supabase/.env.Push them to the "development" environment? [y/N]

   ```

3. On confirmation, the `.env` contents are pushed to the `development` environment via the bulk upsert API (all variables are created as standard).
4. The developer explicitly sets any secrets on the platform:
   ```
   cli env set SUPABASE_AUTH_EXTERNAL_GOOGLE_SECRET "value" --env development --secret
   cli env set STRIPE_KEY "sk_live_abc123" --env development --secret
   ```
5. From this point on, `pull` and `push` work normally.

When the user is ready to set up deployed environments, they seed `preview` from `development` and adjust the values for hosted infrastructure:

```
cli env seed preview --from development --interactive
```

Later, when going to production:

```
cli env seed production --from preview --interactive
```

This creates a natural progression: `development` → `preview` → `production`, each seeded from the last with values adjusted interactively.

If the remote project already has variables (e.g., set up by a teammate), the CLI detects the conflict:

```
The "development" environment already has 12 variables on the platform.
Your local .env has 8 variables.

  [O]verwrite remote with local
  [K]eep remote (discard local .env)
  [C]ancel

Choose: _
```

### End-to-End Example: New Project Lifecycle

```
 1. cli init
    └─ Creates supabase/config.json, empty supabase/.env

 2. User edits config.json, enables Google auth

 3. cli dev
    └─ Fails: missing required variables for auth.external.google
    └─ Shows exact commands to set them

 4. User adds variables to .env
    └─ supabase/.env:
         SUPABASE_AUTH_EXTERNAL_GOOGLE_CLIENT_ID=1234...
         SUPABASE_AUTH_EXTERNAL_GOOGLE_SECRET=GOCSPX-...
         DATABASE_URL=postgres://localhost:5432/app

 5. cli link
    └─ Links to platform project
    └─ Prompts: "Push .env to development?" → yes
    └─ All variables pushed as standard

 5b. Set secrets explicitly on the platform:
    cli env set SUPABASE_AUTH_EXTERNAL_GOOGLE_SECRET "GOCSPX-..." --env development --secret
    └─ Secrets are never pushed from .env — always set via cli env set --secret

 6. New teammate joins:
    cli env pull
    └─ Gets the development .env, runs cli dev — works immediately

 7. Ready for deployed previews:
    cli env seed preview --from development --interactive
    └─ Replaces localhost URLs with hosted preview infrastructure
    └─ Marks sensitive values as secrets

 8. Ready for production:
    cli env seed production --from preview --interactive
    └─ Provides production database, API keys, etc.

 9. Feature branch needs a different API:
    cli env set API_URL "https://feature-x.example.com" --env preview --branch feature-x
    └─ Project branch-specific override, no new environment needed

10. Developer switches Git branch locally while cli dev is running:
    └─ (Planned) CLI syncs project branch and reloads environment automatically
```

---

## Platform API Requirements

The CLI commands described above require the following platform API endpoints:

| Operation              | Endpoint                                                                        | Notes                                             |
| ---------------------- | ------------------------------------------------------------------------------- | ------------------------------------------------- |
| List environments      | `GET /projects/{id}/environments`                                               | Returns default + custom environments             |
| Create environment     | `POST /projects/{id}/environments`                                              | Accepts optional `from` for seeding               |
| Delete environment     | `DELETE /projects/{id}/environments/{name}`                                     | Rejects default environments                      |
| Seed environment       | `POST /projects/{id}/environments/{name}/seed`                                  | Accepts `from`, `interactive` handled client-side |
| List variables         | `GET /projects/{id}/environments/{name}/variables`                              | Secret values returned as `null`                  |
| Bulk upsert variables  | `PUT /projects/{id}/environments/{name}/variables`                              | Accepts full set, computes diff server-side       |
| Set single variable    | `POST /projects/{id}/environments/{name}/variables`                             | Accepts `secret: true` and optional `branch`      |
| Delete single variable | `DELETE /projects/{id}/environments/{name}/variables/{key}`                     | Optional `branch` query param                     |
| Pull variables         | `GET /projects/{id}/environments/{name}/variables?decrypt=true&branch={branch}` | Resolves overrides, excludes secrets              |

The bulk upsert endpoint (`PUT`) is critical. It should accept an array of `{key, value, secret?}` objects and an optional `prune: boolean` flag. The server computes the diff, applies additions/updates, and optionally removes keys not present in the payload. This avoids the one-at-a-time problem that plagues Vercel's CLI.

---

## Dashboard Behavior

The platform dashboard should provide a UI equivalent for all CLI operations:

- View and switch between environments. The three defaults (`development`, `preview`, `production`) are always visible.
- Add, edit, and delete variables. Secret variables show a masked value that cannot be revealed.
- Create and delete custom environments, with the option to seed from an existing one (including interactive review).
- Seed an existing environment from another, with an inline UI for reviewing and editing each variable.
- Edit the branch-to-environment mapping (equivalent to editing the `environments` block in `config.json`).
- View and manage branch-specific overrides, clearly distinguished from base values.

The dashboard is an equal citizen to the CLI — not a secondary interface.

---

## Edge Cases and Decisions

### What happens if a project branch has no mapping?

It falls back to the wildcard (`"*"`) mapping. If no wildcard is configured, it defaults to `preview`. A project branch always resolves to exactly one deployed environment.

### Can two project branches map to the same environment?

Yes. For example, all feature branches mapping to `preview` is the default behavior. Multiple project branches sharing an environment means they share the same base variables (though they can have branch-specific overrides) — this is expected.

### Can a variable exist in some environments but not others?

Yes. Environments are independent. `ANALYTICS_KEY` might exist in `production` but not in `development`. If `env(ANALYTICS_KEY)` is referenced in `config.json` and the value is missing, the CLI should warn at startup rather than fail silently.

### What about multi-line values?

The `.env` parser must handle multi-line values (using quotes), comments, and empty lines. Use an established parsing library rather than a custom regex.

### What about variable expansion in `.env` files?

Variable expansion (e.g., `DATABASE_URL=postgres://${DB_USER}:${DB_PASS}@localhost`) is not supported in `.env` files to keep behavior predictable. Each value is treated as a literal string. Composition should happen in `config.json` using multiple `env()` calls if needed.

---

## Edge Functions

Edge Functions previously had a separate secrets management system (`supabase secrets set/list/unset`, `supabase/functions/.env`). The unified environments system replaces this entirely. The bridge is the `env` field in the functions config block, which declares which variables from the global environment system a function can access.

### Migration from `supabase secrets`

| Old (`supabase secrets`)                    | New (unified `cli env`)                                       |
|---------------------------------------------|---------------------------------------------------------------|
| `supabase secrets set KEY=value`            | `cli env set KEY value --env <environment> [--secret]`        |
| `supabase secrets set --env-file .env`      | `cli env push` (for standard vars) + `cli env set --secret`  |
| `supabase secrets list`                     | `cli env list --env <environment>`                            |
| `supabase secrets unset KEY`                | `cli env unset KEY --env <environment>`                       |
| `supabase/functions/.env`                   | `supabase/.env` (global, from `development` environment)      |

The `supabase secrets` command group is removed. All variable management goes through `cli env`.

### Per-function variable scoping via `config.json`

The `env` field in a function's config block declares which variables from the global environment the function can access at runtime:

```json
{
  "functions": {
    "payment-webhook": {
      "env": {
        "STRIPE_SECRET_KEY": "env(STRIPE_SECRET_KEY)",
        "STRIPE_WEBHOOK_SECRET": "env(STRIPE_WEBHOOK_SECRET)"
      }
    },
    "ai-assistant": {
      "env": {
        "OPENAI_API_KEY": "env(OPENAI_API_KEY)"
      }
    }
  }
}
```

- **Keys** = variable names the function sees via `Deno.env.get()`
- **Values** = `env()` references resolved from the active environment
- **Key can differ from source** — `"API_KEY": "env(OPENAI_API_KEY)"` makes the function see `API_KEY` while the environment stores `OPENAI_API_KEY`
- Functions can **only** access variables declared here plus the platform defaults

This is a **security improvement** over the old system: functions no longer have blanket access to all secrets. Each function declares its dependencies explicitly.

### Resolution for Edge Functions

**Local (`cli dev`):**
The CLI resolves each `env(VAR_NAME)` in the function's `env` block using the standard local resolution chain: OS env → `.env.local` → `.env`. The resolved values are injected into the function's runtime.

**Deployed:**
The platform resolves each `env(VAR_NAME)` from the mapped environment (e.g., `preview`, `production`). Branch-specific overrides apply as usual.

### Platform defaults

Edge Functions automatically receive the following platform variables without needing to declare them in `env`:

- `SUPABASE_URL`
- `SUPABASE_ANON_KEY`
- `SUPABASE_SERVICE_ROLE_KEY`
- `SUPABASE_DB_URL`

These are injected by the platform and are not user-configurable. They do not appear in any environment and cannot be overridden via `env()`.

### Functions without an `env` block

If a function has no `env` block in `config.json`, it receives only the platform defaults. This is the secure default — no user variables leak into functions that don't declare them.

### Missing variable behavior

If a function declares `"STRIPE_KEY": "env(STRIPE_KEY)"` but `STRIPE_KEY` is not set in the active environment, the CLI warns at startup:

```
Warning: functions.payment-webhook.env references missing variables:
  STRIPE_KEY (from env(STRIPE_KEY))

Set it with:
  cli env set STRIPE_KEY "your-value" --env development --secret
```

This is consistent with how missing platform variables are handled elsewhere — warn with actionable guidance rather than fail silently.

---

## Summary

| Concept                      | Decision                                                                                                                                                     |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Environments model           | Flat, independent sets — no inheritance                                                                                                                      |
| Default environments         | `development`, `preview`, and `production` — cannot be deleted                                                                                               |
| `development` environment    | For local execution only (`cli dev`). Not mapped to a branch. Team-shared local defaults.                                                                    |
| `preview` / `production`     | For deployed environments. Mapped to branches via `config.json`.                                                                                             |
| Sharing between environments | Copy/seed at creation time (with interactive review), no live links. Natural progression: development → preview → production.                                |
| Branch-specific overrides    | Supported on deployed environments — set per variable per project branch, resolved automatically on pull                                                     |
| Variables                    | Platform variables (implicit binding) + user variables (`env()` syntax)                                                                                      |
| Secrets                      | A flag on a variable, not a separate system. Set explicitly via `cli env set --secret`. Platform variables auto-classified from config schema. Never pushed from `.env` — always set directly on the platform. |
| Local files                  | `.env` (pulled from `development`) + `.env.local` (personal), both gitignored                                                                                |
| Source of truth              | Platform (remote-first) or `.env` file (local-first)                                                                                                         |
| Sync model                   | `pull`/`push` default to `development`. Pull = full replace, push = diff + upsert (base values only) with optional prune                                     |
| Branch mapping               | Configured in `config.json`, maps project branch names to environments. Wildcard fallback to `preview`. `development` is not in the mapping.                 |
| Resolution (local)           | OS env → `.env.local` → `.env` (from `development`). Planned: `cli dev` will sync Git branch switches with project branch activation and environment reload. |
| Resolution (platform)        | Branch override → base environment variable                                                                                                                  |
| Edge Functions               | `env` block in `config.json` declares per-function variable access. Replaces `supabase secrets`. Functions only see declared `env()` variables + platform defaults (`SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_DB_URL`). |
| API design                   | Bulk upsert endpoint to avoid one-at-a-time limitations                                                                                                      |
