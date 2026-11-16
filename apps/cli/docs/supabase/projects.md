## supabase-projects

Provides tools for creating and managing your Supabase projects.

This command group allows you to list all projects in your organizations, create new projects, delete existing projects, and retrieve API keys. These operations help you manage your Supabase infrastructure programmatically without using the dashboard.

Project management via CLI is especially useful for automation scripts and when you need to provision environments in a repeatable way.

Commands that change your account or projects ask for confirmation first: `create` defaults to yes, `delete` defaults to no. Pass `--yes` (or set `SUPABASE_YES` in your shell) to confirm in scripts and CI; without it, a run that cannot prompt fails before making any change.
