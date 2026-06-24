import { Effect, Layer } from "effect";
import * as net from "node:net";

import { LegacyDebugFlag } from "../../shared/legacy/global-flags.ts";
import {
  LegacyPgDeltaSslProbe,
  LegacyPgDeltaSslProbeError,
} from "./legacy-pgdelta-ssl-probe.service.ts";

/**
 * The Postgres `SSLRequest` startup message (`int32 length=8`, `int32 code=80877103`).
 * The server replies with a single byte: `S` (`0x53`) if it speaks TLS, `N` (`0x4E`)
 * if it refuses. This is exactly the negotiation pgx performs for `sslmode=require`
 * before deciding whether to fail with `"server refused TLS connection"`.
 */
const SSL_REQUEST_PACKET = new Uint8Array([0, 0, 0, 8, 0x04, 0xd2, 0x16, 0x2f]);

/** Default connect timeout when the URL carries no `connect_timeout` (Go's remote 10s). */
const DEFAULT_PROBE_TIMEOUT_MS = 10_000;

/** Parsed dial target for the probe. */
export interface LegacySslProbeTarget {
  readonly host: string;
  readonly port: number;
  readonly timeoutMs: number;
}

/**
 * Parses a `postgresql://` URL into the probe's dial target. Mirrors how Go's
 * `ConnectByUrl` reads `host`/`port`/`connect_timeout`: port defaults to 5432, and
 * the timeout is the URL's `connect_timeout` (seconds) or the 10s remote default.
 */
export function legacyParseSslProbeTarget(dbUrl: string): LegacySslProbeTarget {
  const parsed = new URL(dbUrl);
  const port = parsed.port.length > 0 ? Number.parseInt(parsed.port, 10) : 5432;
  const timeoutParam = parsed.searchParams.get("connect_timeout");
  const timeoutSeconds = timeoutParam !== null ? Number.parseInt(timeoutParam, 10) : 0;
  const timeoutMs =
    Number.isFinite(timeoutSeconds) && timeoutSeconds > 0
      ? timeoutSeconds * 1000
      : DEFAULT_PROBE_TIMEOUT_MS;
  // `URL.hostname` keeps the brackets around an IPv6 literal (`[::1]`), and
  // `net.connect` then treats `[::1]` as a DNS name (`getaddrinfo ENOTFOUND`)
  // instead of dialing the address. Go's pgx path dials the bare `::1` (via
  // `url.Hostname()`), so strip the surrounding brackets to match.
  const hostname = parsed.hostname;
  const host =
    hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
  return { host, port, timeoutMs };
}

/**
 * Interprets the server's single-byte `SSLRequest` reply: `S` → speaks TLS,
 * `N` → refused TLS (Go's `"server refused TLS connection"`). Any other byte is a
 * protocol violation and surfaces as a probe error (Go propagates the connect error).
 */
export function legacyInterpretSslProbeByte(byte: number | undefined): "tls" | "refused" {
  if (byte === 0x53) return "tls"; // 'S'
  if (byte === 0x4e) return "refused"; // 'N'
  throw new LegacyPgDeltaSslProbeError({
    message: `unexpected SSLRequest response byte: ${byte ?? "<empty>"}`,
  });
}

/**
 * Live SSL-capability probe for pg-delta endpoints. Performs a raw Postgres
 * `SSLRequest` negotiation over a TCP socket — the same question Go's `isRequireSSL`
 * answers via `ConnectByUrl(dbUrl+"&sslmode=require")` — without completing the TLS
 * handshake or authenticating (Go defers cert validation to the downstream Deno
 * script). A `connect`/timeout/socket error propagates as a probe failure, matching
 * Go's `return false, err` for non-TLS-refusal errors.
 */
export const legacyPgDeltaSslProbeLayer = Layer.effect(
  LegacyPgDeltaSslProbe,
  Effect.gen(function* () {
    // Go disables SSL in debug mode (`require := !viper.GetBool("DEBUG")`), so a
    // server that speaks TLS still reports "not required" under `--debug`.
    const debug = yield* LegacyDebugFlag;
    return LegacyPgDeltaSslProbe.of({
      requireSsl: (dbUrl) =>
        Effect.gen(function* () {
          const target = yield* Effect.try({
            try: () => legacyParseSslProbeTarget(dbUrl),
            catch: (cause) =>
              new LegacyPgDeltaSslProbeError({
                message: `invalid pg-delta connection URL: ${
                  cause instanceof Error ? cause.message : String(cause)
                }`,
              }),
          });
          const outcome = yield* Effect.callback<"tls" | "refused", LegacyPgDeltaSslProbeError>(
            (resume) => {
              const socket = net.connect({ host: target.host, port: target.port });
              let settled = false;
              const settle = (
                effect: Effect.Effect<"tls" | "refused", LegacyPgDeltaSslProbeError>,
              ) => {
                if (settled) return;
                settled = true;
                socket.destroy();
                resume(effect);
              };
              socket.setTimeout(target.timeoutMs);
              socket.once("connect", () => socket.write(SSL_REQUEST_PACKET));
              socket.once("data", (buf: Buffer) => {
                try {
                  settle(Effect.succeed(legacyInterpretSslProbeByte(buf[0])));
                } catch (cause) {
                  settle(
                    Effect.fail(
                      cause instanceof LegacyPgDeltaSslProbeError
                        ? cause
                        : new LegacyPgDeltaSslProbeError({ message: String(cause) }),
                    ),
                  );
                }
              });
              socket.once("timeout", () =>
                settle(
                  Effect.fail(
                    new LegacyPgDeltaSslProbeError({
                      message: `SSL probe timed out connecting to ${target.host}:${target.port}`,
                    }),
                  ),
                ),
              );
              socket.once("error", (err: Error) =>
                settle(Effect.fail(new LegacyPgDeltaSslProbeError({ message: err.message }))),
              );
              return Effect.sync(() => socket.destroy());
            },
          );
          if (outcome === "refused") return false;
          return !debug;
        }),
    });
  }),
);
