# Task 1 report: stateless observation and polled log following

## Outcome

Implemented the stateless observation contract. Stack handles no longer expose lifecycle `close()` or `watchStatus()`. Log observation is a unary, cursor-based batch API with polling followers.

## Changed files and behavior

- `packages/stack/src/public/Logs.ts`: added `LogQuery`/`StackLogBatch` schemas and types; retained `LogOptions` for the internal `LogStore` seam, with finite tail validation.
- `packages/stack/src/public/EffectStack.ts`: changed `logs` to unary batches, added cursor-polled `followLogs`, advanced cursors across filtered scans, and removed closed-state/handle scope ownership.
- `packages/stack/src/public/PromiseStack.ts`: changed Promise logs to batches, added `followLogs`, and removed the closed guard, iterator registry, and private handle-scope teardown.
- `packages/stack/src/public/Errors.ts`: removed the obsolete status-watch error alias.
- `packages/stack/src/control/StackRpc.ts`: changed `logs` RPC to unary `LogQuery`/`StackLogBatch`; removed streaming `watchStatus` RPC.
- `packages/stack/src/supervisor/Supervisor.ts`: implemented unary filtered/tail batches with running markers and complete-scan cursors; removed status hub/watch stream and log stream RPC handler.
- `packages/stack/src/index.ts`: exported the new log query/batch public types and schemas; removed obsolete root `LogOptions` exports.
- `packages/stack/src/public/Testing.ts`: readiness now polls unary `status()` through an Effect `Schedule`; cleanup no longer calls `close()`.
- `packages/stack/src/public/{effect-stack,promise,testing}.integration.test.ts`: added batch/follower/close-free coverage and migrated fixtures/assertions.
- `packages/stack/src/public/whole-stack.e2e.test.ts`: migrated diagnostics and readiness to unary status/log batches.
- `packages/stack/src/supervisor/{handles,supervisor}.integration.test.ts` and `packages/stack/src/control/control-transport.integration.test.ts`: migrated handles, supervisor, and RPC fixtures to the unary API.
- `apps/cli/src/next/commands/logs/{logs.handler,logs.integration.test}.ts`: non-follow emits `logs(...).entries`; follow uses `followLogs` from the returned cursor.
- `apps/cli/src/shared/functions/managed-functions-runtime.ts`: readiness polls `status()` with a schedule and follows Functions logs through `followLogs`.
- `apps/cli/src/{legacy/commands/functions/serve/serve.integration.test.ts,next/commands/functions/dev/functions-dev-runtime.integration.test.ts}`: updated managed-stack fixtures to the new surface.

## RED evidence

The focused pre-implementation integration run failed as intended with missing unary/follower APIs (runtime errors including `TypeError: stack.logs is not a function` and `TypeError: fixture.supervisor.logs is not a function`) while the old streaming/closed-handle contract was still present.

## GREEN verification

- `bun --bun vitest run --project integration src/public/effect-stack.integration.test.ts src/public/promise.integration.test.ts src/public/testing.integration.test.ts src/supervisor/supervisor.integration.test.ts src/supervisor/handles.integration.test.ts src/control/control-transport.integration.test.ts` — **117 passed** (6 files).
- `bun --bun vitest run --project integration src/public/effect-stack.integration.test.ts -t 'returns filtered log batches|delivers final followed entries'` — **2 passed**.
- `bun --bun vitest run --project integration src/next/commands/functions/dev/functions-dev-runtime.integration.test.ts src/legacy/commands/functions/serve/serve.integration.test.ts` — **9 passed**.
- `bun --bun vitest run --project integration src/next/commands/logs/logs.integration.test.ts` — **2 passed**.
- `pnpm --filter @supabase/stack types:check` — passed.
- `pnpm --filter supabase types:check` — passed.
- `pnpm exec oxlint --config .oxlintrc.effect.json packages/stack` — passed.
- `oxfmt --check` on all 20 changed files and `git diff --check` — passed.

The first broad run encountered an orphaned Supervisor holding port 40000 (PID 91833, owned by the interrupted test run). I terminated that exact process, confirmed the port was free, and reran both affected restart tests (2/2 passed) and the full six-file command above (117/117 passed); no Supervisor remained afterward.

## Commits

- `56bfb3716` — `chore(stack): simplify observation handles`
- Report commit pending (this file is added in the follow-up commit).

## Self-review

- Cursor `v1_0` is treated as the empty sentinel for both live and offline reads, while non-empty cursors advance over every scanned entry before capability filtering/tailing.
- Followers emit each returned batch before checking `running`, then stop polling after the terminal batch; polling delay is expressed with an Effect `Schedule` and is interruptible with the follower stream.
- No ordinary stack handle owns a close operation or active follower registry; each follower owns only its own stream evaluation.
- Internal `LogStore` retains its private `LogOptions`/stream implementation because it is not the public control RPC; the public and RPC surfaces use `LogQuery`/`StackLogBatch`.

## Deviations and concerns

- Ownership was expanded to the requested compile-breaking CLI/function-dev call sites and the root Promise barrel export; no restart behavior was changed.
- Targeted e2e tests were not run (the task brief requires integration/type/lint/format verification; existing e2e helpers were mechanically migrated and app/stack typechecks pass).
