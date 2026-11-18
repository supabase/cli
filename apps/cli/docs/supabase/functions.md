## supabase-functions

Create, serve, deploy and delete Edge Functions, the server-side TypeScript functions that run close to your users on a Deno-compatible edge runtime. They suit webhooks, custom API endpoints, data validation and personalized content, without deploying or scaling a traditional server.

The runtime needs no package management, starts quickly and is secure by default.

Commands that change the hosted project, `functions deploy` (including `--prune`) and `functions delete`, print the `Target:` line and then ask for confirmation before changing anything. The default answer is no. `functions deploy` asks one question covering every function it deploys and every function `--prune` deletes.

Piped answers are never read, so scripts, JSON runs and agents must pass `--yes` or set `SUPABASE_YES` in the shell. A `SUPABASE_YES` in `supabase/.env` does not count.

`functions list` and `functions download` only read and never ask.
