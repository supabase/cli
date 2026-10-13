# Mock account recovery reminder

Set `SUPABASE_ACCOUNT_RECOVERY_REMINDER_MOCK=exhausted`, `missing`, or `low` to preview a short account recovery reminder after a successful CLI command. For example, run `SUPABASE_ACCOUNT_RECOVERY_REMINDER_MOCK=exhausted pnpm dev telemetry status` from `apps/cli` in an interactive terminal. This environment variable is an explicit mock opt-in. The value is not obtained from your account. The CLI does not check your real recovery codes or call a security endpoint.

The reminder appears once per eligible invocation on stderr. It requires an interactive stdin, stdout, and stderr. It is suppressed in CI, detected coding agents, help and version output, delegated Go commands, and machine output modes (`--output-format=json`, `--output-format=stream-json`, or `-o`/`--output`). It does not affect stdout or the command exit code.

This MVP has no cross-invocation cadence or persistence. A real account security signal and reminder rate limit require a separate backend contract.

## Screenshot commands

From the repository root, use one of these commands to preview the reminder without the development-build upgrade notice:

```bash
SUPABASE_NO_UPDATE_NOTIFIER=1 SUPABASE_ACCOUNT_RECOVERY_REMINDER_MOCK=exhausted CLICOLOR_FORCE=1 mise x -- pnpm --filter supabase dev telemetry status
SUPABASE_NO_UPDATE_NOTIFIER=1 SUPABASE_ACCOUNT_RECOVERY_REMINDER_MOCK=missing CLICOLOR_FORCE=1 mise x -- pnpm --filter supabase dev telemetry status
SUPABASE_NO_UPDATE_NOTIFIER=1 SUPABASE_ACCOUNT_RECOVERY_REMINDER_MOCK=low CLICOLOR_FORCE=1 mise x -- pnpm --filter supabase dev telemetry status
```
