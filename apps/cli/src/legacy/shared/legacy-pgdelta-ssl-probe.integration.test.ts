import { createServer } from "node:net";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Exit, Layer } from "effect";

import { LegacyDebugFlag } from "../../shared/legacy/global-flags.ts";
import { legacyPgDeltaSslProbeLayer } from "./legacy-pgdelta-ssl-probe.layer.ts";
import {
  LegacyPgDeltaSslProbe,
  LegacyPgDeltaSslProbeError,
} from "./legacy-pgdelta-ssl-probe.service.ts";

async function withClosingServer<T>(run: (port: number) => Promise<T>): Promise<T> {
  const server = createServer((socket) => {
    socket.destroy();
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });

  const address = server.address();
  if (address === null || typeof address === "string") {
    server.close();
    throw new Error("failed to bind closing server");
  }

  try {
    return await run(address.port);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}

describe("legacyPgDeltaSslProbeLayer", () => {
  it.live("fails promptly when the socket closes before an SSL response byte", () =>
    Effect.tryPromise({
      try: () =>
        withClosingServer((port) =>
          Effect.runPromise(
            Effect.gen(function* () {
              const probe = yield* LegacyPgDeltaSslProbe;
              const exit = yield* probe.requireSslForHost("127.0.0.1", port).pipe(
                Effect.timeoutOrElse({
                  duration: "1 second",
                  orElse: () => Effect.fail(new Error("probe did not settle after socket close")),
                }),
                Effect.exit,
              );

              expect(Exit.isFailure(exit)).toBe(true);
              if (Exit.isFailure(exit)) {
                expect(String(exit.cause)).toContain(LegacyPgDeltaSslProbeError.name);
                expect(String(exit.cause)).toContain("closed before the server responded");
              }
            }).pipe(
              Effect.provide(legacyPgDeltaSslProbeLayer),
              Effect.provide(Layer.succeed(LegacyDebugFlag, false)),
            ),
          ),
        ),
      catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
    }),
  );
});
