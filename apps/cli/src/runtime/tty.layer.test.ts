import process from "node:process";
import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { Tty } from "./tty.service.ts";
import { ttyLayer } from "./tty.layer.ts";

describe("Tty", () => {
  it.effect("reads TTY state from node:process stdio", () =>
    Effect.gen(function* () {
      const tty = yield* Tty;
      expect(tty.stdinIsTty).toBe(!!process.stdin.isTTY);
      expect(tty.stdoutIsTty).toBe(!!process.stdout.isTTY);
    }).pipe(Effect.provide(ttyLayer)),
  );
});
