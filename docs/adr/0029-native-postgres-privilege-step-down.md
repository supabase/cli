# 0029. Native Postgres privilege step-down

**Status**: proposed
**Date**: 2026-10-07

## Problem Statement

[ADR 0025](0025-ephemeral-postgres-for-schema-tooling.md) refuses native Postgres when the process
uid is 0, because `initdb` refuses to run as root, and tells users to pick `--runtime docker`.
Containers and agent sandboxes commonly run the CLI as root without a container engine, so that
rule leaves no working runtime there. Automatic runtime selection also only chose between Docker
and native, ignoring Podman.

## Decision

- When the stack runs as root, only the PostgreSQL process steps down to an unprivileged user. The
  user is named by `SUPABASE_NATIVE_POSTGRES_USER`, or is the account of a detected agent sandbox.
  The CLI itself keeps running as root and hands the instance data, root key, and socket directory
  to that user. Without either, native startup still refuses root.
- Auto-selecting the runtime of a new stack probes Docker, then Podman, then falls back to native
  where native artifacts exist. An explicit `--runtime` has no fallback, and a saved runtime never
  flips.

## Rationale

Stepping down only the process that requires it keeps the rest of the stack unchanged and avoids a
second privilege model. Probing Podman before native means a machine with either engine gets
containers, as it does when started explicitly.

## Consequences

### Positive

- Native stacks start in root-only environments when a user is named or a sandbox is detected.
- Podman-only machines get a container runtime by default.

### Negative

- Root-owned native stacks need ownership changes on stack state and traverse permission on parent
  directories, described in the `stack start` side effects.
- A runtime chosen automatically after skipping Docker is sticky until the stack is destroyed or a
  new stack name is used.

## Alternatives Considered

1. **Keep refusing root**: leaves root-only environments without a runtime.
2. **Run the whole stack as the unprivileged user**: requires re-executing the CLI and splits
   state ownership across users.

## Related Decisions

- [ADR 0025](0025-ephemeral-postgres-for-schema-tooling.md): the native-as-root and default
  runtime rules this decision amends.

## See Also

- [`stack start` side effects](../../apps/cli/src/commands/experimental/stack/start/SIDE_EFFECTS.md)
