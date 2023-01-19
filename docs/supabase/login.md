## supabase-login

Connect Supabase CLI to your Supabase account by logging in with your [personal access token](https://app.supabase.com/account/tokens).

Your access token will be stored securely in [native credentials storage](https://github.com/zalando/go-keyring#dependencies). If native credentials storage is unavailable, it will be written to a plain text file at `~/.supabase/access-token`.

> If this behaviour is not desired, such as in a CI environment, you may skip login by specifying `SUPABASE_ACCESS_TOKEN` environment variable in other commands.

Supabase CLI uses the stored token to access Management APIs, such as projects, functions, secrets, etc.
