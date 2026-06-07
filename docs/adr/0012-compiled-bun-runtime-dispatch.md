# 0012. Compiled Bun Runtime Dispatch

**Status**: proposed
**Date**: 2026-05-13

## Problem Statement

ADR 0011 chooses Bun `--compile` single-file executables as the TypeScript CLI packaging format. That artifact shape matches the existing Go CLI distribution model, but compiled Bun does not behave exactly like `bun <script>` when a process tries to launch another TypeScript entrypoint.

In Bun JIT mode, `process.execPath` is the Bun runtime, so `child_process.fork(entrypoint)` effectively runs `bun <entrypoint>`. In a compiled executable, `process.execPath` is the CLI binary itself. Passing a script path as argv re-enters the compiled binary's baked entrypoint instead of running that script. Detached daemon startup and process supervision therefore need an explicit dispatch contract.

Compiled Bun also makes runtime source paths and dynamic native bindings different from a checkout. Source files can live in Bun's embedded filesystem, optional native packages are only included when they are statically referenced, and code that expects a stable filesystem path can fail at runtime.

This surfaced in:

- [CLI-1452](https://linear.app/supabase/issue/CLI-1452/compiled-bun-compile-next-binary-cant-run-supabase-functions-dev): the next binary could not run `supabase functions dev` because `@parcel/watcher` native bindings and the Edge Runtime bootstrap were not safe under the compiled binary.
- [CLI-1453](https://linear.app/supabase/issue/CLI-1453/compiled-bun-compile-next-binary-start-detach-daemon-fork-ignores): `supabase start --detach` failed because the daemon fork re-entered the CLI entrypoint instead of the daemon entrypoint.

## Decision

Compiled-binary dispatch is explicit and owned by the layer that owns the process being launched:

- The CLI/stack layer owns Supabase-specific daemon dispatch. `forkDaemon` marks daemon children with `SUPABASE_STACK_RUN_DAEMON=1`; the compiled next CLI entrypoint checks that marker and runs the Bun daemon entrypoint in-process.
- `@supabase/process-compose` owns generic supervisor dispatch. Supervised services are launched through `process.execPath`; when the library is bundled into a compiled Bun binary, a small internal environment protocol asks the same binary to run the supervisor runtime path.
- The supervisor runtime and protocol stay as native `.ts` source files. Bun and supported Node versions can run them directly, so process-compose does not need a JavaScript sidecar or Supabase-specific code.
- Native watcher packages are referenced through static literal `require("@parcel/watcher-...")` calls so Bun can include the platform optional dependencies in compiled binaries.
- The Edge Runtime bootstrap source is embedded with Bun's text import attribute and written to the runtime temp directory before launch, instead of being read from a source path that may live inside Bun's embedded filesystem.
- The next CLI e2e harness runs against the compiled `supabase-next` binary so regressions are caught against the same artifact users run.

## Rationale

The compiled binary is the public artifact, so child-process behavior must be designed around that artifact rather than around development-mode script launching.

Environment markers keep the contract small and side-effect free:

- They do not depend on argv shape that compiled Bun ignores.
- They let the compiled binary self-dispatch without extracting sidecar JavaScript files.
- They keep Supabase-specific daemon knowledge out of the generic process-compose package.

Using `process.execPath` in process-compose preserves runtime symmetry. If the library runs under Bun, it forks Bun; if it runs under Node, it forks Node. The only compiled-Bun-specific behavior is the self-dispatch marker, which is internal to the process-compose runtime contract.

Static native imports and text-embedded bootstrap source avoid relying on filesystem paths that are not stable after `bun --compile`.

## Consequences

### Positive

- Detached stack commands and supervised services work from the compiled next CLI binary.
- Process-compose remains a generic Node/Bun supervision library, not a Supabase CLI adapter.
- The e2e suite now exercises the distributed binary for next CLI workflows.

### Negative

- The environment variable names are internal contracts and must be changed carefully.
- Native dependencies used by compiled binaries need static literal references; dynamic native resolution is unsafe.
- Source files that must exist at runtime need explicit embedding or extraction.

## Alternatives Considered

1. **Keep relying on script-path argv**: rejected because compiled Bun ignores this shape and re-enters the baked entrypoint.
2. **Ship sidecar JavaScript runtime files**: rejected for now because it adds release artifacts and path management that `process.execPath` self-dispatch avoids.
3. **Move Supabase daemon knowledge into process-compose**: rejected because process-compose is a generic supervision library.
4. **Use dynamic `@parcel/watcher` resolution**: rejected because Bun cannot reliably include platform optional native packages from dynamic require paths.

## Related Decisions

- [ADR 0011](0011-cli-release-and-distribution-strategy.md): CLI Release & Distribution Strategy
- [ADR 0010](0010-process-manager-architecture.md): Process Manager Architecture

## See Also

- [Detached mode](../../packages/stack/docs/detach-mode.md)
