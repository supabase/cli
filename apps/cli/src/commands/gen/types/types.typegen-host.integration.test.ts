import { BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { ChildProcessSpawner } from "effect/unstable/process";
import { makeTypegenHost } from "./types.typegen-host.ts";

describe.skipIf(process.platform === "win32")("makeTypegenHost with the real spawner", () => {
  it.effect("survives a tool that exits before reading a large stdin", () =>
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const runPromise = Effect.runPromiseWith(yield* Effect.context<never>());
      const host = makeTypegenHost({
        cwd: process.cwd(),
        env: {},
        platform: process.platform,
        spawner,
        runPromise,
      });
      if (host.spawn === undefined) throw new Error("the typegen host must supply spawn");
      // Far more than a pipe buffer holds, so the write meets the closed pipe for certain.
      const result = yield* Effect.promise(() =>
        host.spawn!({
          command: "sh",
          args: ["-c", "exit 3"],
          cwd: process.cwd(),
          env: {},
          stdin: "x".repeat(4 * 1024 * 1024),
        }),
      );
      expect(result.exitCode).toBe(3);
    }).pipe(Effect.provide(BunServices.layer)),
  );
});
