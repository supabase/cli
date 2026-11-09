## supabase-login

Connect the Supabase CLI to your Supabase account by signing in with your [personal access token](https://supabase.com/dashboard/account/tokens).

Your access token is stored securely in native credentials storage (the operating system keyring). If native credentials storage is unavailable, it will be written to a plain text file at `<SUPABASE_HOME or ~/.supabase>/access-token`.

> If this behavior is not desired, such as in a CI environment, you may skip login by specifying the `SUPABASE_ACCESS_TOKEN` environment variable in other commands.

The Supabase CLI uses the stored token to access Management APIs for projects, functions, secrets, etc.

> The Management API client retries retryable failures up to 5 times by default. Set `SUPABASE_API_MAX_RETRIES` to change that. It counts retries after the first attempt, so `0` sends each request once.
