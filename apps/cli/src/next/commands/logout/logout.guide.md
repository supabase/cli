# Logout

Log out of Supabase and remove the stored access token from your system.

## When to use

Run to revoke local CLI access — for example when switching accounts, on a shared machine, or after finishing work. The stored token is deleted from your system keyring (or the fallback file `<SUPABASE_HOME or ~/.supabase>/access-token`). After logging out, commands that require auth will prompt you to log in again.

<!-- USAGE:START -->
<!-- USAGE:END -->

<!-- FLAGS:START -->
<!-- FLAGS:END -->

<!-- EXAMPLES:START -->
<!-- EXAMPLES:END -->

## Tips

- If you have no token stored, the command exits cleanly with a notice rather than an error
- Pass `--yes` to skip the confirmation prompt in scripts or non-interactive environments
- In CI, prefer `SUPABASE_ACCESS_TOKEN` per-run rather than persisting a token with login/logout
- To switch accounts without logging out, run `supabase login` directly — it will prompt to confirm before overwriting the stored token
