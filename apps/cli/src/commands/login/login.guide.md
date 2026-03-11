# Login

Log in to Supabase by providing an access token or using browser-based OAuth.

## When to use

Run once to authenticate before using commands that require auth (e.g. `supabase projects list`, `supabase db push`, `supabase functions deploy`). The token is persisted — you do not need to log in again until it expires or is revoked. In CI, skip login entirely by setting `SUPABASE_ACCESS_TOKEN`.

<!-- USAGE:START -->
<!-- USAGE:END -->

<!-- FLAGS:START -->
<!-- FLAGS:END -->

<!-- EXAMPLES:START -->
<!-- EXAMPLES:END -->

## Tips

- Token resolution priority: `--token` flag > `SUPABASE_ACCESS_TOKEN` env > piped stdin > interactive browser flow
- Generate tokens at https://supabase.com/dashboard/account/tokens
