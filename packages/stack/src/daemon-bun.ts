import { BunServices } from "@effect/platform-bun";
import * as BunHttpServer from "@effect/platform-bun/BunHttpServer";
import { Effect, Layer } from "effect";
import { runDaemon } from "./daemon.ts";

export function runBunDaemon(): void {
  runDaemon(
    ({ apiPort, releaseApiPort }) =>
      Layer.mergeAll(
        BunServices.layer,
        Layer.unwrap(releaseApiPort.pipe(Effect.as(BunHttpServer.layer({ port: apiPort })))),
      ),
    (socketPath) => BunHttpServer.layer({ idleTimeout: 0, unix: socketPath }),
  );
}

if (import.meta.main) {
  runBunDaemon();
}
