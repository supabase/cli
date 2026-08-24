import { BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Exit, Option } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { childSignalFromCause } from "./ChildSignal.ts";

describe("childSignalFromCause", () => {
  it.live("decodes the signal from an actual child-process exit cause", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        const child = yield* spawner.spawn(
          ChildProcess.make(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
            stdin: "ignore",
            stdout: "ignore",
            stderr: "ignore",
          }),
        );
        yield* child.kill({ killSignal: "SIGTERM" });
        const result = yield* child.exitCode.pipe(Effect.exit);

        expect(Exit.isFailure(result)).toBe(true);
        if (Exit.isFailure(result)) {
          expect(Option.getOrUndefined(childSignalFromCause(result.cause))).toBe("SIGTERM");
        }
      }),
    ).pipe(Effect.provide(BunServices.layer)),
  );
});
