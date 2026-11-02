## supabase-functions

Manage Supabase Edge Functions.

Supabase Edge Functions are server-less functions that run close to your users.

Edge Functions allow you to execute custom server-side code without deploying or scaling a traditional server. They're ideal for handling webhooks, custom API endpoints, data validation, and serving personalized content.

Edge Functions are written in TypeScript and run on Deno compatible edge runtime, which is a secure runtime with no package management needed, fast cold starts, and built-in security.

Commands that change the hosted project — `functions deploy` (including `--prune`) and `functions delete` — print the `Target:` line, then ask for confirmation before changing anything; the default answer is no. `functions deploy` asks one question covering every function it will deploy and every function `--prune` will delete. Piped answers are never read, so scripts, JSON runs and agents must pass `--yes` or set `SUPABASE_YES` in the shell (a `SUPABASE_YES` in `supabase/.env` does not count). `functions list` and `functions download` only read and never ask.
