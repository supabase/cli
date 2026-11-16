import { describe, expect, test } from "vitest";
import { BunFileSystem, BunPath } from "@effect/platform-bun";
import { Context, Effect, FileSystem, Layer, Option, Terminal } from "effect";
import { findCliProjectRoot } from "./bun.ts";

// `bun.ts`'s facade only needs `FileSystem | Path`, so a facade call must never attach the
// permanent `process.stdin` "end" listener that `Terminal` (pulled in by `BunServices.layer`)
// adds on first use. This is only observable on the very first facade call anywhere in the
// process, since the facade's `ManagedRuntime` is a lazy, module-level singleton — so this
// file must make exactly one facade call, and no other test here may call into `bun.ts` before or after it.
describe("promise-facade stdin-leak regression (CLI-2231)", () => {
  test("the first facade call in this file does not attach a process.stdin 'end' listener", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "supabase-promise-facade-stdin-" });
        const before = process.stdin.listenerCount("end");

        yield* Effect.promise(() => findCliProjectRoot(cwd));

        expect(process.stdin.listenerCount("end")).toBe(before);
      }).pipe(Effect.scoped, Effect.provide(BunFileSystem.layer)),
    ));
});

describe("bun.ts's platform layer excludes Terminal", () => {
  // Builds the same layer `bun.ts` provides its `ManagedRuntime` independently, so it
  // doesn't count as a second facade call, and asserts there's no `Terminal` service at all
  // rather than just that using one doesn't touch stdin today.
  test("Layer.mergeAll(BunFileSystem.layer, BunPath.layer) builds a context with no Terminal service", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const context = yield* Layer.build(Layer.mergeAll(BunFileSystem.layer, BunPath.layer)).pipe(
          Effect.scoped,
        );

        expect(Option.isNone(Context.getOption(context, Terminal.Terminal))).toBe(true);
      }),
    ));
});
