# Dev Alpha Command Structure

## Purpose

This document defines the alpha command structure for the new Supabase CLI.

For alpha, we will design the command surface from `supabase dev` outward. The goal is not to mirror the old CLI or the Management API. The goal is to give both humans and LLMs one command set that feels obvious, consistent, and reusable.

`supabase dev` is the primary human entry point. The subcommands underneath it are the reusable building blocks that `dev`, `push`, and `pull` orchestrate directly. In alpha, `push` and `pull` are platform sync workflows, while local database mutation uses `apply`.

For alpha, the command structure is optimized for:

- one intuitive command set for humans and LLMs
- workflow-first naming
- a consistent local versus remote mental model
- reusable subcommands under `dev`, `push`, and `pull`

Older docs may still use different names. This document is the source of truth for the alpha command structure.

## Naming Principles

### `schema` is the primary public group for database shape changes

For alpha, we will use `schema` as the user-facing command group for database shape changes.

`schema` is clearer than `migrations` because it matches the user intent. Users are usually trying to evolve the database shape, inspect changes, or sync those changes. Migration files are an implementation detail of that workflow.

For alpha, the declarative schema workflow comes first. `schema` is the default path we will teach, document, and optimize for.

`schema generate` means "turn my declared schema intent into migration files without applying them yet."

`schema apply` means "apply my declared schema intent to the local database." Under the hood, that may derive or update migration files before applying them, but the public workflow stays schema-first.

`schema push` means "sync my declared schema intent to the platform." In practice, that can include deriving or updating migrations and then pushing that result to the platform as one schema-first workflow. It is a platform-sync command, not a local database mutation command.

`schema pull` means "pull schema state from the platform into the local schema representation." It is the reverse platform-sync command.

### `migrations` is the advanced escape hatch

For alpha, we will also support a lower-level `migrations` command group for users who want direct file-level control.

`migrations` is not the primary onboarding surface. It exists for users who need to inspect, author, apply, or push raw migration files directly.

`migrations` should stay unaware of the declarative schema workflow. It is the lower-level primitive layer, not the place where schema generation logic lives.

### `push` and `pull` are platform-only sync verbs

For alpha, `push` and `pull` mean sync with the platform only.

That rule applies across:

- `schema push` / `schema pull`
- `functions push` / `functions pull`
- `config push` / `config pull`
- `env push` / `env pull`
- top-level `push` / `pull`

Using `push` and `pull` only for platform sync keeps the directionality obvious. Users do not need to guess whether a command is going to touch the platform or mutate a live local database.

### `apply` is the local database mutation verb

For alpha, `apply` is the verb for mutating a live local database.

That rule applies to:

- `schema apply`
- `migrations apply`

Using `apply` here is clearer than overloading `push`, because it signals direct local database side effects rather than platform synchronization.

`apply` does not replace `migrations push`. `migrations apply` is local database mutation, while `migrations push` is the explicit low-level platform sync path for users working directly with migration files.

### `functions push` and `functions pull` replace `deploy` and `download`

For alpha, we will use `push` and `pull` for platform Edge Function sync.

This keeps the command language consistent across platform-sync asset types:

- `schema push`
- `functions push`
- `config push`
- `env push`

The same rule applies to `pull`. A user should not need to memorize a special verb just because the asset type is Functions.

### `local` replaces `stack`

For alpha, we will use `local` as the public command group for local runtime lifecycle.

`stack` is technically accurate, but `local` is easier to understand. It describes the execution context directly, which makes the local versus remote model easier to learn.

### `branches` is plural

For alpha, we will use `branches` as the public group name.

The plural form reads more naturally alongside the rest of the command tree and makes the overall grouping feel more consistent next to `functions` and `local`.

### `new` means local authoring and scaffolding

For alpha, we will use `new` when the command creates something in the repo or local workspace.

Examples:

- `functions new`
- `migrations new`

This establishes a simple rule: `new` is for starting local work.

### `create` means remote platform resource creation

For alpha, we will use `create` when the command provisions something on the platform.

Examples:

- `branches create`

This gives `new` and `create` a clean semantic split:

- `new` = local authoring and scaffolding
- `create` = remote resource creation

## Recommended Alpha Command Tree

The public command surface for alpha is:

- Workflows
  - `supabase dev`
  - `supabase push`
  - `supabase pull`
- Schema
  - `supabase schema diff`
  - `supabase schema generate`
  - `supabase schema apply`
  - `supabase schema push`
  - `supabase schema pull`
- Migrations
  - `supabase migrations new`
  - `supabase migrations list`
  - `supabase migrations apply`
  - `supabase migrations push`
  - `supabase migrations pull`
- Functions
  - `supabase functions new`
  - `supabase functions list`
  - `supabase functions dev`
  - `supabase functions push`
  - `supabase functions pull`
- Environment (future, when environment management will be implemented in the API)
  - `supabase env list`
  - `supabase env set`
  - `supabase env unset`
  - `supabase env pull`
  - `supabase env push`
  - `supabase env seed`
- Config
  - `supabase config diff`
  - `supabase config pull`
  - `supabase config push`
- Branches
  - `supabase branches list`
  - `supabase branches create`
  - `supabase branches switch`
- Local
  - `supabase local start`
  - `supabase local stop`
  - `supabase local status`
  - `supabase local logs`
- Setup and auth
  - `supabase init`
  - `supabase link`
  - `supabase unlink`
  - `supabase login`
  - `supabase logout`

This structure follows a simple mental model:

- top-level workflows for the big jobs: `dev`, `push`, `pull`
- asset groups for focused sync and authoring: `schema`, `migrations`, `functions`, `env`, `config`
- context groups for runtime and branch selection: `local`, `branches`
- setup and auth commands kept top-level: `init`, `link`, `login`

## How `dev` Uses These Commands

For alpha, `dev` will be an orchestrator over the command tree above. It will not be a separate logic silo.

### `dev --target local`

`dev --target local` will orchestrate the local development workflow by composing the lower-level commands:

- `local start` to bring up local services
- `schema apply` to apply local database changes
- `migrations apply` for direct migration-file workflows
- `functions dev` to run a Functions-only local development loop
- local env and config resolution to keep the local runtime aligned with project inputs

In alpha, `dev` should watch both declarative schema inputs and direct migration files under `supabase/migrations`. Declarative schema remains the primary workflow, but users who need more control should still be able to work at the migrations layer without fighting `dev`.

The local workflow should feel like a single command, but it should still be built from the same subcommands a user or agent can run directly.

### `dev --target remote`

`dev --target remote` will orchestrate the remote development workflow against a linked non-production branch.

At a high level, it will coordinate:

- `schema push`
- `functions push`
- remote config sync

The remote workflow should use the same asset groups and the same command vocabulary as the local workflow. The difference is target and orchestration, not a separate command language.

When users edit migration files directly, `dev` should reconcile through the same migration-backed database sync pipeline rather than introducing a second competing path.

### `push`

For alpha, `push` will be the global sync workflow across:

- `schema`
- `functions`
- `env`
- `config`

`push` is the command for syncing local intent outward using the same lower-level asset commands.

For database changes, top-level `push` runs the schema-first remote sync path.

Advanced users can still use `migrations push` when they want explicit low-level control over what gets synchronized to the platform.

### `pull`

For alpha, `pull` will be the global sync workflow across:

- `schema`
- `functions`
- `env`
- `config`

`pull` is the command for refreshing local state from the remote source of truth using the same lower-level asset commands.

`pull` does not apply local database changes. It refreshes local project state from the platform.

## Alpha Scope

Before `dev` feels coherent in alpha, the following command families must exist:

- `schema`
- `migrations`
- `functions`
- `env`
- `config`
- `branches` essentials
- `local` lifecycle commands
- top-level `push` and `pull`

The alpha should feel complete enough that `dev` can orchestrate a believable end-to-end workflow rather than stand on placeholders.

### In scope for this document

- the public naming of command groups and verbs
- the high-level command tree
- the relationship between `dev` and the supporting subcommands
- the workflow role of `push` and `pull`

### Out of scope for this document

- compatibility aliases
- parity with the old CLI
- implementation details of watchers, transport, or API wiring
- detailed handler boundaries or runtime architecture

## Design Notes

### Why `schema` is better user language than `migrations`

`schema` describes what the user is trying to change. `migrations` describes one mechanism used to represent those changes. The command surface should privilege user intent over implementation terms.

### Why `schema` owns generation and `migrations` does not

`schema` is the declarative workflow layer. It is responsible for diffing, generation, and high-level sync because those operations start from declared schema intent.

`migrations` is the lower-level execution layer. It should only manage concrete migration files and their application history. Keeping that boundary clean prevents the lower-level command group from becoming aware of higher-level declarative concepts.

That lower-level layer can still expose both local mutation and platform sync commands. The important boundary is that `migrations` does not need to understand declarative schema generation.

### Why `migrations` should still exist

Some users will need more control than the high-level schema workflow provides. A dedicated `migrations` group gives them a direct path for working with raw migration files without forcing that mental model onto everyone else.

### Why platform-only `push` and `pull` improve learnability

Using `push` and `pull` only for platform sync creates one directional vocabulary for the entire CLI. Once a user understands `schema push`, it is natural to understand `functions push`, `config push`, `env push`, and then top-level `push` without wondering whether the command will mutate a local database.

### Why `apply` is clearer than overloading `push`

`apply` communicates a direct change to a live local database. That is a different action from synchronizing project state with the platform, so it deserves a different verb. Keeping `migrations push` alongside `migrations apply` preserves this distinction cleanly: `apply` is local mutation, `push` is platform sync.

### Why `local` is clearer than `stack`

`local` tells the user exactly which world they are operating in. It makes commands like `local start` and `local logs` immediately understandable and reinforces the local versus remote model.

### Why consistent verbs matter more than legacy naming

The alpha should optimize for clarity, not familiarity with older names. A consistent verb system makes the CLI easier to learn, easier to document, and easier for LLMs to compose correctly.

## Summary

For alpha, we will use a command structure centered on `dev`, with reusable supporting commands grouped by workflow and asset type.

The public command surface is:

- workflow-first
- consistent across local and remote development
- based on `schema`, `migrations`, `functions`, `env`, `config`, `branches`, and `local`
- unified around `push` and `pull` as the platform sync verbs

For database changes specifically, the alpha model is:

- `schema` for declarative authoring, diffing, generation, local apply, and schema-first platform sync
- `migrations` for direct file-level control, explicit local application, and explicit migration-level platform sync

`dev` will orchestrate this command tree rather than replace it.
