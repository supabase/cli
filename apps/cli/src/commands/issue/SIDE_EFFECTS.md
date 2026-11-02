# `supabase issue`

## Side effects

- Opens a GitHub issue form URL in the user's default browser, unless `--no-browser` is passed.
- Writes the generated issue form URL to stdout.
- `--crash-report-id` only prefills the issue form's ticket-id field; the CLI no longer creates
  crash reports or support tickets (the global `--create-ticket` flag is removed).

## No local project changes

This command does not read or write Supabase project files, stack state, credentials, or linked
project metadata.
