import process from "node:process";
import { Effect, Layer } from "effect";

import { Tty } from "./tty.service.ts";

export const ttyLayer = Layer.effect(
  Tty,
  Effect.tryPromise(() => Bun.file(1).stat()).pipe(
    Effect.map((stats) => stats.isFIFO()),
    Effect.orElseSucceed(() => false),
    Effect.map((stdoutIsPipe) =>
      Tty.of({
        stdinIsTty: !!process.stdin.isTTY,
        stdoutIsTty: !!process.stdout.isTTY,
        stdoutIsPipe,
      }),
    ),
  ),
);
