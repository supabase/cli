import { NodeHttpClient, NodeServices } from "@effect/platform-node";
import { Data, Effect, Layer, Option, Stream } from "effect";
import {
  runHostProcessIfDispatched,
  runNativeProcessIfDispatched,
} from "../src/internal/dispatch.ts";
import {
  connectHost,
  launchHost,
  shutdownHost,
  waitForOwnerExit,
  type HostEndpoint,
} from "../src/HostProcess.ts";
import { spawnNativeProcess } from "../src/runtime/NativeProcess.ts";
import * as State from "../src/State.ts";

const argv = process.argv.slice(2);
class FixtureError extends Data.TaggedError("FixtureError")<{ readonly message: string }> {}
if (!(await runHostProcessIfDispatched(argv)) && !(await runNativeProcessIfDispatched(argv))) {
  const [mode, ...modeArgs] = argv;
  const output = (endpoint: HostEndpoint) => process.stdout.write(`${JSON.stringify(endpoint)}\n`);

  if (mode === "owner" || mode === "stop") {
    const [stateRoot, cacheRoot, stackId] = modeArgs;
    if (stateRoot === undefined || stackId === undefined)
      throw new Error("Owner fixture arguments missing");
    const program = Effect.scoped(
      Effect.gen(function* () {
        const state = yield* State.Service;
        const access = yield* mode === "owner"
          ? launchHost(state, { stateRoot, cacheRoot: cacheRoot ?? stateRoot, stackId })
          : connectHost(state, stackId);
        if (mode === "stop") {
          const refusal = yield* shutdownHost(access, false);
          if (Option.isSome(refusal))
            return yield* new FixtureError({ message: refusal.value.message });
          yield* waitForOwnerExit(access.endpoint.pid);
        }
        output(access.endpoint);
      }),
    ).pipe(
      Effect.provide(
        Layer.mergeAll(
          NodeServices.layer,
          NodeHttpClient.layerNodeHttp,
          State.layer({ root: stateRoot }).pipe(Layer.provide(NodeServices.layer)),
        ),
      ),
    );
    await Effect.runPromise(program);
  } else if (mode === "native") {
    const [pidMarker] = modeArgs;
    if (pidMarker === undefined) throw new Error("Native fixture arguments missing");
    const program = Effect.scoped(
      Effect.gen(function* () {
        const native = yield* spawnNativeProcess({
          executable: "/bin/sh",
          args: [
            "-c",
            "trap 'exit 0' TERM; printf '%s' \"$$\" > \"$1\"; printf 'native-child-ready\\n'; while :; do sleep 1; done",
            "sh",
            pidMarker,
          ],
          gracefulStopSignal: "SIGTERM",
          gracefulStopTimeout: "2 seconds",
        });
        yield* native.stdout.pipe(
          Stream.decodeText,
          Stream.splitLines,
          Stream.runHead,
          Effect.flatMap(
            Option.match({
              onNone: () =>
                Effect.fail(new FixtureError({ message: "Native child exited before readiness" })),
              onSome: Effect.succeed,
            }),
          ),
        );
        process.stdout.write("native-ready\n");
        yield* native.kill;
        yield* Effect.exit(native.exitCode);
        process.stdout.write("native-stopped\n");
      }),
    ).pipe(Effect.provide(NodeServices.layer));
    await Effect.runPromise(program);
  } else {
    throw new Error(`Unknown fixture mode: ${mode}`);
  }
}
