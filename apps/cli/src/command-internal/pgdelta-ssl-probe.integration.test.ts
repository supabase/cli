import { createServer } from "node:net";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Exit, Layer } from "effect";

import { DebugFlag } from "./global-flags.ts";
import { pgDeltaSslProbeLayer } from "./pgdelta-ssl-probe.layer.ts";
import { PgDeltaSslProbe, PgDeltaSslProbeError } from "./pgdelta-ssl-probe.service.ts";

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

describe("pgDeltaSslProbeLayer", () => {
  it.live("fails promptly when the server disconnects before an SSL response byte", () =>
    Effect.tryPromise({
      try: () =>
        withClosingServer((port) =>
          Effect.runPromise(
            Effect.gen(function* () {
              const probe = yield* PgDeltaSslProbe;
              const exit = yield* probe.requireSslForHost("127.0.0.1", port).pipe(
                Effect.timeoutOrElse({
                  duration: "1 second",
                  orElse: () => Effect.fail(new Error("probe did not settle after socket close")),
                }),
                Effect.exit,
              );

              expect(Exit.isFailure(exit)).toBe(true);
              if (Exit.isFailure(exit)) {
                expect(String(exit.cause)).toContain(PgDeltaSslProbeError.name);
              }
            }).pipe(
              Effect.provide(pgDeltaSslProbeLayer),
              Effect.provide(Layer.succeed(DebugFlag, false)),
            ),
          ),
        ),
      catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
    }),
  );
});
