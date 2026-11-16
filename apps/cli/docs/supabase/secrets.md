## supabase-secrets

Provides tools for managing environment variables and secrets for your Supabase project.

This command group allows you to set, unset, and list secrets that are securely stored and made available to Edge Functions as environment variables.

Secrets management through the CLI is useful for:

- Setting environment-specific configuration
- Managing sensitive credentials securely

Secrets can be set individually or loaded from .env files for convenience.

`secrets set` and `secrets unset` print the `Target:` line, then ask for confirmation before changing anything; the default answer is no, and the question lists the secret names (never their values). Piped answers are never read, so scripts, JSON runs and agents must pass `--yes` or set `SUPABASE_YES` in the shell (a `SUPABASE_YES` in `supabase/.env` does not count). `secrets unset --dry-run` and `secrets list` only read and never ask.
