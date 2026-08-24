import { Clock, DateTime, Effect, Layer } from "effect";

import { LegacyDebugFlag } from "../../shared/legacy/global-flags.ts";
import { LegacyDebugLogger } from "./legacy-debug-logger.service.ts";

const pad = (n: number): string => String(n).padStart(2, "0");

/** Formats a timestamp matching Go's `log.LstdFlags`: `YYYY/MM/DD HH:MM:SS`. */
function formatTimestamp(now: DateTime.DateTime): string {
  const parts = DateTime.toParts(now);
  return (
    `${parts.year}/${pad(parts.month)}/${pad(parts.day)} ` +
    `${pad(parts.hour)}:${pad(parts.minute)}:${pad(parts.second)}`
  );
}

export const legacyDebugLoggerLayer = Layer.effect(
  LegacyDebugLogger,
  Effect.gen(function* () {
    const debug = yield* LegacyDebugFlag;

    const writeLine = (message: string) =>
      Effect.sync(() => {
        if (debug) process.stderr.write(`${message}\n`);
      });

    const timestamp = (method: string, url: string) =>
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        return `${formatTimestamp(DateTime.makeZonedUnsafe(now, { timeZone: DateTime.zoneMakeLocal() }))} HTTP ${method}: ${url}`;
      });

    return LegacyDebugLogger.of({
      debug: writeLine,
      http: (method, url) => timestamp(method, url).pipe(Effect.flatMap(writeLine)),
    });
  }),
);
