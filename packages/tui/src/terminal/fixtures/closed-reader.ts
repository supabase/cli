import { NodeRuntime } from "@effect/platform-node";
import { Console, Effect } from "effect";

import * as Terminal from "../terminal.ts";

const chunk = `${"x".repeat(65_535)}\n`;

const writeUntilRefused = Effect.gen(function* () {
  const terminal = yield* Terminal.Service;
  while (true) yield* terminal.write(chunk);
}).pipe(
  Effect.catchTag("TerminalError", (error) => Console.error(`terminal-error: ${error.reason}`)),
);

writeUntilRefused.pipe(Effect.provide(Terminal.layerProcess()), NodeRuntime.runMain);
