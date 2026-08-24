import { BunServices } from "@effect/platform-bun";
import { Effect, Exit, Layer } from "effect";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import { prefetch } from "@supabase/stack";

const hasDockerDaemon = Effect.scoped(
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const result = yield* spawner
      .exitCode(ChildProcess.make("docker", ["info"], { stdout: "ignore", stderr: "ignore" }))
      .pipe(Effect.exit);
    return Exit.isSuccess(result) && result.value === 0;
  }),
);

const prefetchEffect = (mode?: "docker") =>
  Effect.tryPromise(() => (mode ? prefetch({ mode }) : prefetch())).pipe(Effect.asVoid);

const globalSetupEffect = Effect.gen(function* () {
  const dockerAvailable = yield* hasDockerDaemon;
  const warmups = [prefetchEffect()];

  if (dockerAvailable) {
    warmups.push(prefetchEffect("docker"));
  }

  yield* Effect.all(warmups, { concurrency: "unbounded", discard: true });
});

export default function globalSetup() {
  return Effect.runPromise(
    globalSetupEffect.pipe(Effect.provide(Layer.mergeAll(BunServices.layer))),
  );
}
