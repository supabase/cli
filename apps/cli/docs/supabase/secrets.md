## supabase-secrets

Set, unset and list the secrets that your Edge Functions read as environment variables. Use them for environment-specific configuration and sensitive credentials. You can set secrets individually or load them from a `.env` file.

`secrets set` and `secrets unset` print the `Target:` line and then ask for confirmation before changing anything. The default answer is no, and the question lists the secret names, never their values.

Piped answers are never read, so scripts, JSON runs and agents must pass `--yes` or set `SUPABASE_YES` in the shell. A `SUPABASE_YES` in `supabase/.env` does not count.

`secrets unset --dry-run` and `secrets list` only read and never ask.
