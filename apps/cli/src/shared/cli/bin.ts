#!/usr/bin/env node
import { NodeServices } from "@effect/platform-node";
import { childSignalFromCause } from "@supabase/process-compose";
import { Config, ConfigProvider, Data, Effect, Exit, Layer, Option, Path } from "effect";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import { createRequire } from "node:module";
import os from "node:os";
import {
  actionability,
  type CliErrorActionabilityDeclaration,
  ErrorActionabilityId,
} from "../telemetry/error-actionability.ts";

const PLATFORMS: Record<string, Record<string, ReadonlyArray<string>>> = {
  darwin: { arm64: ["darwin-arm64"], x64: ["darwin-x64"] },
  linux: {
    arm64: ["linux-arm64", "linux-arm64-musl"],
    x64: ["linux-x64", "linux-x64-musl"],
  },
  win32: { arm64: ["windows-arm64"], x64: ["windows-x64"] },
};

class CliShimError extends Data.TaggedError("CliShimError")<{
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.impossibleState;
  }
}

const require = createRequire(import.meta.url);
const forwardedSignals: ReadonlyArray<NodeJS.Signals> = ["SIGINT", "SIGTERM", "SIGHUP"];

const resolveBinary = (path: Path.Path, override: Option.Option<string>) => {
  const platformMap = PLATFORMS[process.platform];
  if (platformMap === undefined) {
    return Effect.fail(new CliShimError({ message: `Unsupported platform: ${process.platform}` }));
  }
  const candidates = platformMap[os.arch()];
  if (candidates === undefined) {
    return Effect.fail(
      new CliShimError({
        message: `Unsupported architecture: ${os.arch()} on ${process.platform}`,
      }),
    );
  }
  const ext = process.platform === "win32" ? ".exe" : "";
  const configured = Option.getOrUndefined(override);
  if (configured !== undefined && configured.length > 0) return Effect.succeed(configured);

  for (const suffix of candidates) {
    try {
      const packagePath = path.dirname(require.resolve(`@supabase/cli-${suffix}/package.json`));
      return Effect.succeed(path.join(packagePath, "bin", `supabase${ext}`));
    } catch {
      // The optional platform package is not installed; try the next candidate.
    }
  }
  return Effect.fail(
    new CliShimError({
      message: `No matching Supabase CLI binary package found for ${process.platform}-${os.arch()}`,
    }),
  );
};

// `SUPABASE_CLI_BINARY_OVERRIDE` lets tests and local dev point the shim at a
// specific compiled binary on disk, bypassing the optional-dependency lookup.
// This is the entrypoint the e2e harness uses to exercise the real shim +
// compiled binary handoff without publishing platform packages.
const main = Effect.scoped(
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const override = yield* Config.option(Config.string("SUPABASE_CLI_BINARY_OVERRIDE"));
    const binPath = yield* resolveBinary(path, override);
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const child = yield* spawner.spawn(
      ChildProcess.make(binPath, process.argv.slice(2), {
        stdin: "inherit",
        stdout: "inherit",
        stderr: "inherit",
        detached: false,
      }),
    );
    const context = yield* Effect.context();
    const forwarders = new Map<NodeJS.Signals, () => void>();
    yield* Effect.acquireRelease(
      Effect.sync(() => {
        for (const signal of forwardedSignals) {
          const forward = () => {
            Effect.runForkWith(context)(child.kill({ killSignal: signal }).pipe(Effect.ignore));
          };
          process.on(signal, forward);
          forwarders.set(signal, forward);
        }
      }),
      () =>
        Effect.sync(() => {
          for (const [signal, forward] of forwarders) process.removeListener(signal, forward);
        }),
    );

    const result = yield* child.exitCode.pipe(Effect.exit);
    if (Exit.isFailure(result)) {
      const childSignal = Option.getOrUndefined(childSignalFromCause(result.cause));
      if (childSignal !== undefined) {
        return {
          _tag: "signal" as const,
          signal: childSignal,
        };
      }
      return yield* Effect.failCause(result.cause);
    }
    return { _tag: "exit" as const, exitCode: result.value };
  }),
);

if (import.meta.main) {
  const executable = main.pipe(
    Effect.provide(
      Layer.mergeAll(
        NodeServices.layer,
        ConfigProvider.layer(ConfigProvider.fromEnv({ preserveEmptyStrings: true })),
      ),
    ),
    Effect.flatMap((outcome) => {
      if (outcome._tag === "signal") {
        // The compiled binary owns signal semantics, so the shim never dies
        // to a signal's default action while the child runs: a group signal
        // (terminal Ctrl-C) already reaches the child directly, and a signal
        // sent to the shim PID alone (a supervisor's kill) is forwarded so
        // cancellation still lands. The scoped region has removed the
        // forwarding listeners before this self-signal, so it cannot be
        // intercepted and forwarded again.
        return Effect.sync(() => process.kill(process.pid, outcome.signal)).pipe(
          Effect.andThen(Effect.never),
        );
      }
      return Effect.sync(() => process.exit(outcome.exitCode));
    }),
  );

  await Effect.runPromise(executable).catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
}
