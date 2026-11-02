import { createServer, type Server } from "node:net";
import { describe, expect, it } from "@effect/vitest";
import { Data, Effect, Exit } from "effect";

import { pgDeltaSslProbeLayer } from "./pgdelta-ssl-probe.layer.ts";
import { PgDeltaSslProbe, PgDeltaSslProbeError } from "./pgdelta-ssl-probe.service.ts";

class FixtureError extends Data.TaggedError("FixtureError")<{
  readonly message: string;
}> {}

const closingServer = Effect.acquireRelease(
  Effect.callback<{ readonly server: Server; readonly port: number }, FixtureError>((resume) => {
    const server = createServer((socket) => {
      socket.destroy();
    });
    const onError = (cause: Error) =>
      resume(Effect.fail(new FixtureError({ message: cause.message })));
    server.once("error", onError);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", onError);
      const address = server.address();
      if (address === null || typeof address === "string") {
        server.close();
        resume(Effect.fail(new FixtureError({ message: "failed to bind closing server" })));
      } else {
        resume(Effect.succeed({ server, port: address.port }));
      }
    });
    return Effect.sync(() => {
      server.off("error", onError);
      server.close();
    });
  }),
  ({ server }) =>
    Effect.callback<void>((resume) => {
      server.close((error) => resume(error ? Effect.die(error) : Effect.void));
    }),
);

describe("pgDeltaSslProbeLayer", () => {
  it.live("fails promptly when the server disconnects before an SSL response byte", () =>
    Effect.gen(function* () {
      const { port } = yield* closingServer;
      const probe = yield* PgDeltaSslProbe;
      const exit = yield* probe.requireSslForHost("127.0.0.1", port).pipe(
        Effect.timeoutOrElse({
          duration: "1 second",
          orElse: () =>
            Effect.fail(new FixtureError({ message: "probe did not settle after socket close" })),
        }),
        Effect.exit,
      );

      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(String(exit.cause)).toContain(PgDeltaSslProbeError.name);
      }
    }).pipe(Effect.provide(pgDeltaSslProbeLayer)),
  );
});
