# Plan: Schema-First Database Development (V1)

This is the implementation plan for the Schema-First RFC (revised 2026-08-18).
It is the working spec for the `feat/implement-rfc-schema-first-development` branch.

## Product decisions (locked)

1. Declarative SQL in `supabase/schemas/*.sql` is the primary source of database-shape intent.
2. Migrations in `supabase/migrations/*.sql` are the durable deployment recipe.
3. `schema apply` may journal-apply a pg-delta plan only to a verified-disposable local target.
4. `migrations push` is the only CLI path that mutates a durable remote schema. No `schema push`.
5. `schema generate` is declarations → migrations. `schema pull` is database → declarations.
6. `schema generate --dry-run` previews generate. `migrations diff` replaces `db diff`.
7. `schema pull` is database-authoritative regeneration (`--force` / `--output`). No merge.
8. `--yes` answers ordinary prompts. Durable identity is `--yes` or matching `--project-ref` for linked targets, and `--allow-remote` for raw URLs. There is no `--allow-data-loss`. Local disposable `schema apply` auto-approves modeled hazards.
9. New commands live at top level in the **legacy** (stable) CLI. The same verbs also stay on next (alpha). Go-parity `db` and singular `migration` stay on stable. Plural `migrations` is the schema-first group (it is no longer an alias of `migration`).
10. `schema generate` / `apply` / `migrations diff|push|pull` plan against **isolated native Postgres clusters** with a cached platform baseline — not co-located `CREATE DATABASE` shadows. `planSchemaFiles` always uses `isolatedShadow: true`.

## Open questions (resolved for V1)

| # | Decision |
| - | -------- |
| 1 | No tracked schema checkpoint sidecar. Export ownership stays in `.pgdelta-export.json`. Draft journal: `.supabase/schema-draft.json` (gitignored). Existing `.schema-checkpoint.json` files are ignored. |
| 2 | After a successful non-dry `schema generate` (including no-op when `M` already equals `D`), the draft journal is cleared. Local history is never written at generate time. `migrations apply` runs pending SQL, or inserts missing `supabase_migrations` rows when the live catalog already matches full file replay. Catalog match is schema-shape only — a pending DML-only file can be recorded without executing. Local `db reset` clears the journal. Reset is optional rebuild, not required to apply additive files. |
| 3 | `schema generate --baseline --name <name>` is the existing-database onboarding step. Registering that baseline as already applied on a remote is a separate, explicit migration-history operation (not pull). |
| 4 | Manual migration changes during an active ungenerated draft fail closed with generate / reset / discard. No automatic rebase. |
| 5 | Push does not classify pending files as destructive. Generate still fail-closes on ambiguous rename / coverage gaps. |
| 6 | Only a running local stack owned by this project is verified-disposable. Every remote/URL target is durable. No environment classification yet. |
| 7 | Clone proof is not required. Generate verifies by planning `M → D` and checking convergence on a clean replay. Push live-verifies declarations-ahead (`M → D`) and remote drift unless `--skip-verify`. |
| 8 | `migrations diff` supports `--file` / `-f` (preview-to-file, no apply). |
| 9 | Isolated shadows are native Postgres (same binaries as `start`), snapshotted under `$SUPABASE_HOME/cache/native-shadow-baseline/`. Co-located shadows are not used on this path. |

## Shell and ownership

```
apps/cli/src/shared/schema/       engine adapter, workspace, journal, use cases, runtime
apps/cli/src/shared/migrations/   repository, history, runner, use cases
apps/cli/src/shared/database/     target resolution, pool, mutation auth
apps/cli/src/legacy/commands/schema/
apps/cli/src/legacy/commands/migrations/
apps/cli/src/next/commands/schema/      same verbs on alpha
apps/cli/src/next/commands/migrations/
apps/cli/src/next/commands/db/          compatibility aliases only
apps/cli/src/next/commands/migration/   compatibility aliases only
```

- `next/` must not import `legacy/`. `legacy/` must not import `next/`.
- Handlers call one use case and render. Handlers must not import other handlers.
- Use cases and schema runtime live in `shared/` so both shells can call them.
- pg-delta stays the compiler. The CLI owns paths, targets, prompts, locks, and output.

## Command surface (stable / legacy)

| Command | Source → action | Side effects |
| ------- | --------------- | ------------ |
| `schema pull` | L/R → D | Declarative files, manifest (primary tree only) |
| `schema generate --dry-run` | M → D | None |
| `schema generate` | M → D | Migration files; clears draft journal |
| `schema apply` | L → D | Local DB + draft journal |
| `migrations new` | — | Empty migration file |
| `migrations list` | files ↔ history | None |
| `migrations diff` | M → live | Preview (optional `--file`) |
| `migrations apply` | pending files → L | Local DB + `supabase_migrations` |
| `migrations push` | pending files → R | Remote DB + history; fail closed on declarations-ahead or drift unless `--skip-verify` |
| `migrations pull` | R − M → files | Migration files |

### Aliases (next only, deprecation notice on stderr)

| Alias | Target |
| ----- | ------ |
| `db diff` | `migrations diff` |
| `db push` | `migrations push` |
| `db pull` (default) | `migrations pull` |
| `db pull --declarative` | `schema pull --from linked` |
| `db schema declarative generate` | `schema pull` |
| `db schema declarative sync` | `schema generate` (`--apply` also runs `schema apply`) |
| `migration new` / `migrations` already | `migrations new` |
| `migration list` | `migrations list` |
| `migration up` | `migrations apply` |

## Safety

- Target identity comes from stack ownership or linked project-ref, never hostname heuristics.
- `--yes` never bypasses the target gate or live verify (unless `--skip-verify`).
- Durable identity: interactive confirm-by-typing-ref; non-interactive `--yes` or matching `--project-ref`.
- Raw URL targets: `--allow-remote` instead of ref assertion.
- Local `schema apply`: auto-approve modeled hazards. Ambiguous rename / coverage gap / unknown metadata still fail closed.
- `--skip-verify` skips push’s isolated-shadow declarations-ahead and remote-drift checks. Identity flags unchanged.
- Project lock: `.supabase/schema.lock`.

## Out of scope

- Top-level `push` / `pull` composition (CLI-1271 / CLI-1272)
- Composite `schema push`
- Semantic three-way merge
- File watcher / TUI
- Replacing Go-parity `db` / singular `migration` on stable
- Marketing "provable no-data-loss"
