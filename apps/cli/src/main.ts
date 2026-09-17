#!/usr/bin/env bun
import { BunRuntime } from "@effect/platform-bun";
import { Cause, Data, Effect } from "effect";
import {
  NATIVE_PROCESS_DISPATCH_SENTINEL,
  SUPERVISOR_DISPATCH_SENTINEL,
  runNativeProcessIfDispatched,
  runSupervisorProcessIfDispatched,
} from "@supabase/stack/internal/supervisor";
import {
  actionability,
  type CliErrorActionabilityDeclaration,
  ErrorActionabilityId,
} from "./shared/telemetry/error-actionability.ts";

export class CliEntrypointError extends Data.TaggedError("CliEntrypointError")<{
  readonly message: string;
  readonly cause: unknown;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.unknown;
  }
}

const argv = process.argv.slice(2);
const main = Effect.gen(function* () {
  if (yield* runSupervisorProcessIfDispatched(argv)) return;
  if (yield* runNativeProcessIfDispatched(argv)) return;
  yield* Effect.tryPromise({
    try: () => import("./cli/main.ts"),
    catch: (cause) => new CliEntrypointError({ message: "CLI entrypoint failed", cause }),
  });
});

if (argv[0] === NATIVE_PROCESS_DISPATCH_SENTINEL || argv[0] === SUPERVISOR_DISPATCH_SENTINEL) {
  BunRuntime.runMain(main);
} else {
  // The imported CLI runner owns signals and process lifetime, so avoid a second SIGINT owner.
  Effect.runFork(
    main.pipe(
      Effect.catchCause((cause) =>
        Effect.sync(() => {
          process.stderr.write(`${Cause.pretty(cause)}\n`);
          process.exitCode = 1;
        }),
      ),
    ),
  );
}
