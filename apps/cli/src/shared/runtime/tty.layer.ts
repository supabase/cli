import process from "node:process";
import { Layer } from "effect";

import { Tty } from "./tty.service.ts";

export const ttyLayer = Layer.sync(Tty, () =>
  Tty.of({
    stdinIsTty: !!process.stdin.isTTY,
    stdoutIsTty: !!process.stdout.isTTY,
  }),
);
