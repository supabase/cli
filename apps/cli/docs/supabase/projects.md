## supabase-projects

Create, list and delete Supabase projects, and read their API keys, without opening the dashboard. This is useful for automation scripts and for provisioning environments repeatably.

Commands that change your account or projects ask for confirmation first: `create` defaults to yes, `delete` defaults to no.

Pass `--yes` (or set `SUPABASE_YES` in your shell) to confirm in scripts and CI. Without it, a run that cannot prompt fails before making any change.
