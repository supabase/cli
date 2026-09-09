import { Effect, Layer } from "effect";

import { DebugFlag } from "./global-flags.ts";
import { DebugLogger } from "./debug-logger.service.ts";

const pad = (n: number): string => String(n).padStart(2, "0");

/** Formats a timestamp matching Go's `log.LstdFlags`: `YYYY/MM/DD HH:MM:SS`. */
function formatTimestamp(now: Date): string {
  return (
    `${now.getFullYear()}/${pad(now.getMonth() + 1)}/${pad(now.getDate())} ` +
    `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`
  );
}

export const debugLoggerLayer = Layer.effect(
  DebugLogger,
  Effect.gen(function* () {
    const debug = yield* DebugFlag;

    const writeLine = (message: string) =>
      Effect.sync(() => {
        if (debug) process.stderr.write(`${message}\n`);
      });

    return DebugLogger.of({
      debug: writeLine,
      http: (method, url) => writeLine(`${formatTimestamp(new Date())} HTTP ${method}: ${url}`),
    });
  }),
);
