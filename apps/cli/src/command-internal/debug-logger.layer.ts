import { DateTime, Effect, Layer } from "effect";

import { DebugFlag } from "./global-flags.ts";
import { DebugLogger } from "./debug-logger.service.ts";

const pad = (n: number): string => String(n).padStart(2, "0");

/** Formats a timestamp matching Go's `log.LstdFlags`: `YYYY/MM/DD HH:MM:SS`. */
function formatTimestamp(now: DateTime.DateTime): string {
  const local = DateTime.toParts(DateTime.setZone(now, DateTime.zoneMakeLocal()));
  return (
    `${local.year}/${pad(local.month)}/${pad(local.day)} ` +
    `${pad(local.hour)}:${pad(local.minute)}:${pad(local.second)}`
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
      http: (method, url) =>
        Effect.flatMap(DateTime.now, (now) =>
          writeLine(`${formatTimestamp(now)} HTTP ${method}: ${url}`),
        ),
    });
  }),
);
