This guidance matches the installed CLI version. Run `supabase skill display <topic>` for per-topic detail. If you are following older instructions, read the [v2 to v3 migration guide](https://supabase.com/docs/guides/local-development/cli/migrating-to-v3).

## Before you run commands

- Run `supabase <command> --help` for exact flags. It is authoritative.
- Replace `<...>` placeholders, such as `<ref>`, with real values before running a command.
- For commands that return structured results, use `--output-format json` for parsing. It is already the default when an agent is detected. `stream-json` emits NDJSON for long-running commands. `skill display` always prints markdown, whatever the format.

## Targeting

- Commands target the local stack unless `--remote` is passed.
- `--remote` with no value targets the linked project.
- `--remote=<ref|branch|url>` targets a specific project ref, branch, or Postgres URL.
- Never use the v2 target flags `--local`, `--linked`, `--project-ref`, or `--db-url`. Use `--remote` instead.
- Commands that connect to local services, such as `db query` without `--remote`, need the running stack. Check it with `supabase status` and start it with `supabase start`. Never restart it in a loop.

```bash
supabase status
supabase start
```

## Linking and credentials for `--remote`

- Bare `--remote` needs a linked project. If a command reports that the project is not linked, ask the user which project to use, then link it. Alternatively, pass `--remote=<ref>`.
- Hosted commands need an access token. Use `supabase login` interactively, or `SUPABASE_ACCESS_TOKEN` in the environment (CI or agents).
- Database commands such as `db push`, `db pull`, `migration list`, and `migration repair` may also need the database password. Pass `--password` or set `SUPABASE_DB_PASSWORD`. Never write the password into files.

```bash
supabase link <ref>
```

## Hosted changes need user approval

- When the CLI detects an agent, it never prompts. Unless approval is already present, a command that changes a hosted project fails on its first run with a "Confirmation required" error. The error says nothing was changed and suggests asking the user. This is the designed path, not a bug.
- Show the user what will change, using the error's details and the command, and ask. Only after the user approves, re-run the same command with `--yes` added.
- `SUPABASE_YES=1` exported in the shell counts as approval, so hosted changes run with no confirmation error. When it is set, ask the user before running any command that changes a hosted project. `supabase/.env` and other `.env` files are ignored, and piping `y` does not work.
- Read-only alternatives need no approval. Examples are `db query --read-only` and `db push --dry-run`.

```bash
supabase db query --remote --read-only "select 1"
```

## Errors

- In JSON mode, errors arrive as an envelope with `message` and often `suggestion`. Read both.
- Never re-run a failing command unchanged. Fix the input, the SQL, or the link first. The one exception is the approved `--yes` re-run.

## Safety rules

- Never run `db reset --remote` unless the user explicitly asks for it.
- Never edit the migration history table by hand.
- Never invent migration filenames.
