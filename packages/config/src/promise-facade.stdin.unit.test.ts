import { describe, expect, test } from "vitest";
import { BunFileSystem, BunPath } from "@effect/platform-bun";
import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Context, Effect, Layer, Option, Terminal } from "effect";
import { findProjectRootFor } from "./bun.ts";

// CLI-2231 regression guard: `BunServices.layer` (the full Bun platform
// services bundle) pulls in `Terminal`, which attaches a permanent
// `process.stdin` "end" listener the first time it's used. `bun.ts`'s
// facade only needs `FileSystem | Path` (see `bun.ts`), so a facade call
// must never grow that listener count.
//
// This is only meaningful on the FIRST facade call made anywhere in the
// process — `promise-facade.ts`'s `ManagedRuntime` is a lazily-built,
// module-level singleton, so a call made before this test's "before"
// snapshot would already have built the runtime (and attached any
// listener), making the before/after comparison vacuously pass. This file
// deliberately makes exactly ONE call into the bun facade — the call
// below — and no other test in this file may call into `bun.ts` (or any
// other module that shares its singleton) before or after it. Vitest's
// default per-file module isolation (`isolate: true`) is what guarantees
// this file's copy of `bun.ts` starts with its runtime unbuilt; putting
// this assertion in a file with other facade-calling tests (as the
// original version of this guard did) silently defeats it, which is
// exactly how this regression shipped and passed CI.
describe("promise-facade stdin-leak regression (CLI-2231)", () => {
  test("the first facade call in this file does not attach a process.stdin 'end' listener", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "supabase-promise-facade-stdin-"));
    const before = process.stdin.listenerCount("end");

    try {
      await findProjectRootFor(cwd);

      expect(process.stdin.listenerCount("end")).toBe(before);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});

describe("bun.ts's platform layer excludes Terminal", () => {
  // A structural companion to the behavioral guard above: builds the exact
  // layer `bun.ts` provides its `ManagedRuntime` — independent of `bun.ts`
  // and the facade singleton, so it doesn't count as a second facade call —
  // and asserts the resulting `Context` has no `Terminal` service at all,
  // not just that using it happens not to touch stdin today.
  test("Layer.mergeAll(BunFileSystem.layer, BunPath.layer) builds a context with no Terminal service", async () => {
    const context = await Effect.runPromise(
      Layer.build(Layer.mergeAll(BunFileSystem.layer, BunPath.layer)).pipe(Effect.scoped),
    );

    expect(Option.isNone(Context.getOption(context, Terminal.Terminal))).toBe(true);
  });
});
