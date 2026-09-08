# Experimental stack restart side effects

## Command and files

`supabase experimental stack restart` reads the selected stack descriptor and
configuration from that descriptor's project root. The command handler is in
`restart.handler.ts`; shared status rendering is in `../stack.shared.ts`.

## Stack operations

- Resolves one existing stack using `--stack`, `--stack-id`, or the current project.
- Opens that stack, prepares the supplied configuration, stops the owner, and starts the same handle with the same durable identity.
- Never creates or destroys a stack. Configuration or preparation failures happen before stop; a stop failure does not start; a start failure leaves the stack stopped and recoverable.

## Filesystem, environment, and output

Configuration and durable state use the CLI settings and `SUPABASE_HOME` resolved by the existing CLI layers. The command does not write project configuration. Text output includes lifecycle, endpoints, and dormant capabilities; JSON output contains the public status projection and no secrets. The legacy `-o/--output` flag is rejected in favor of `--output-format`.

## Errors and telemetry

Expected stack failures are classified with actionable guidance and retain their original cause. Defects and interruption remain failures. The command uses the standard experimental stack instrumentation and output task; a successful task is cleared after the new status is available, while failures fail the task before propagating.
