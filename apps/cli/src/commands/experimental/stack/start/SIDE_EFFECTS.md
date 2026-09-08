# `supabase stack start`

This command creates or resumes the managed stack identified by the current
project and optional `--stack`, or opens an existing stack with `--stack-id`.
The `@supabase/stack` Effect API owns persistent state, the detached
Supervisor, runtime resources, readiness, and cleanup. The CLI only resolves
the project configuration and renders the resulting status.

`SUPABASE_HOME` controls the package's durable stack state through its normal
runtime composition boundary. The stack owner is deliberately detached from
the command waiter, so returning from a successful start leaves the stack
running for later commands. An interrupted start is handled by the package's
owner cleanup contract.

Text output includes the stack id, lifecycle, endpoints, and dormant
capabilities. Structured output includes the same status fields. The command reads configured
credentials and function/provider secrets to pass them to the stack runtime, but
never emits those values.

`--stack` and `--stack-id` are mutually exclusive. `--runtime auto` uses the
package default; `docker` selects the Docker container runtime; `native`
selects the native runtime. `--preparation` controls background versus
on-demand artifact preparation, and `--eager` requests enabled capabilities be
activated before the command returns.

The command owns only the start request. Once the package reports readiness,
the detached stack owner remains alive after the CLI process exits. If the CLI
caller is interrupted while waiting, the package's owner lifecycle decides
whether the start can complete or must clean up; the CLI does not call stop or
destroy as a cancellation handler.
