import { BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { ChildProcessSpawner } from "effect/process";
import { makeTypegenHost } from "./types.typegen-host.ts";

describe.skipIf(process.platform === "win32")("makeTypegenHost with the real spawner", () => {
  const spawnInto = (tool: string, stdin: string) =>
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
      return yield* Effect.promise(() =>
        host.spawn!({ command: "sh", args: ["-c", tool], cwd: process.cwd(), env: {}, stdin }),
      );
    }).pipe(Effect.provide(BunServices.layer));

  // A write this small completes before the tool exits, so the pipe's EPIPE arrives after the
  // sink has stopped listening; only the patched stdin error listener keeps it from crashing
  // the process (seen on Linux, never on macOS).
  it.effect("survives a tool that exits before reading a small stdin", () =>
    Effect.gen(function* () {
      const result = yield* spawnInto("exit 3", "x".repeat(1024));
      expect(result.exitCode).toBe(3);
    }),
  );

  // Far more than a pipe buffer holds, so the write itself meets the closed pipe for certain.
  it.effect("survives a tool that exits before reading a large stdin", () =>
    Effect.gen(function* () {
      const result = yield* spawnInto("exit 3", "x".repeat(4 * 1024 * 1024));
      expect(result.exitCode).toBe(3);
    }),
  );
});
