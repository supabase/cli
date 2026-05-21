import { Effect, Layer } from "effect";
import { FetchHttpClient } from "effect/unstable/http";
import * as HttpClient from "effect/unstable/http/HttpClient";

import { LegacyDebugFlag } from "../../shared/legacy/global-flags.ts";

const pad = (n: number): string => String(n).padStart(2, "0");

/** Formats a timestamp matching Go's `log.LstdFlags`: `YYYY/MM/DD HH:MM:SS`. */
function formatTimestamp(now: Date): string {
  return (
    `${now.getFullYear()}/${pad(now.getMonth() + 1)}/${pad(now.getDate())} ` +
    `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`
  );
}

/**
 * Wraps `FetchHttpClient.layer` so that, when `--debug` is set, every HTTP
 * request is logged to stderr in the exact format Go uses
 * (`apps/cli-go/internal/debug/http.go`): `HTTP <YYYY/MM/DD HH:MM:SS> <METHOD>: <URL>\n`.
 *
 * When `--debug` is unset, this is identity over `FetchHttpClient.layer` — no
 * runtime overhead beyond a single boolean check at layer-construction time.
 */
export const legacyHttpClientLayer = Layer.unwrap(
  Effect.gen(function* () {
    const debug = yield* LegacyDebugFlag;
    if (!debug) {
      return FetchHttpClient.layer;
    }

    return Layer.effect(
      HttpClient.HttpClient,
      Effect.gen(function* () {
        const base = yield* HttpClient.HttpClient;
        return HttpClient.mapRequest(base, (req) => {
          process.stderr.write(`HTTP ${formatTimestamp(new Date())} ${req.method}: ${req.url}\n`);
          return req;
        });
      }),
    ).pipe(Layer.provide(FetchHttpClient.layer));
  }),
);
