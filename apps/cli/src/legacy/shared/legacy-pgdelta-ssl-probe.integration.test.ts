import { createServer } from "node:net";
import { describe, expect, it } from "@effect/vitest";
import { Cause, Effect, Exit, Layer } from "effect";

import { LegacyDebugFlag } from "../../shared/legacy/global-flags.ts";
import { legacyPgDeltaSslProbeLayer } from "./legacy-pgdelta-ssl-probe.layer.ts";
import {
  LegacyPgDeltaSslProbe,
  LegacyPgDeltaSslProbeError,
} from "./legacy-pgdelta-ssl-probe.service.ts";

function withClosingServer<A, E, R>(run: (port: number) => Effect.Effect<A, E, R>) {
  return Effect.acquireUseRelease(
    Effect.callback<
      { readonly port: number; readonly server: ReturnType<typeof createServer> },
      Cause.UnknownError
    >((resume) => {
      const server = createServer((socket) => {
        socket.destroy();
      });
      server.once("error", (error) =>
        resume(Effect.fail(new Cause.UnknownError(error, String(error)))),
      );
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        if (address === null || typeof address === "string") {
          resume(Effect.fail(new Cause.UnknownError(undefined, "failed to bind closing server")));
        } else {
          resume(Effect.succeed({ port: address.port, server }));
        }
      });
      return Effect.sync(() => {
        if (server.listening) server.close();
      });
    }),
    ({ port }) => run(port),
    ({ server }) =>
      Effect.callback<void, Cause.UnknownError>((resume) => {
        server.close((error) =>
          error === undefined
            ? resume(Effect.void)
            : resume(Effect.fail(new Cause.UnknownError(error, String(error)))),
        );
      }),
  );
}

describe("legacyPgDeltaSslProbeLayer", () => {
  it.live("fails promptly when the server disconnects before an SSL response byte", () =>
    withClosingServer((port) =>
      Effect.gen(function* () {
        const probe = yield* LegacyPgDeltaSslProbe;
        const exit = yield* probe.requireSslForHost("127.0.0.1", port).pipe(
          Effect.timeoutOrElse({
            duration: "1 second",
            orElse: () =>
              Effect.fail(
                new Cause.UnknownError(
                  undefined,
                  String("probe did not settle after socket close"),
                ),
              ),
          }),
          Effect.exit,
        );

        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          expect(String(exit.cause)).toContain(LegacyPgDeltaSslProbeError.name);
        }
      }).pipe(
        Effect.provide(
          Layer.mergeAll(legacyPgDeltaSslProbeLayer, Layer.succeed(LegacyDebugFlag, false)),
        ),
      ),
    ),
  );
});
