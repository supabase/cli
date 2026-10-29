// oxlint-disable-next-line effecttsgo/node-builtin-import -- the Effect FileSystem service exposes no stat on a raw file descriptor.
import { fstatSync } from "node:fs";
import process from "node:process";
import { Effect, Layer } from "effect";

import { Tty } from "./tty.service.ts";

export const ttyLayer = Layer.effect(
  Tty,
  Effect.try(() => fstatSync(1).isFIFO()).pipe(
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
