import { BunServices } from "@effect/platform-bun";
import * as BunHttpServer from "@effect/platform-bun/BunHttpServer";
import { fileURLToPath } from "node:url";
import { Effect, Layer } from "effect";
import { runManagedDaemon } from "./managed-daemon.ts";
import { createManagedStackServiceWith } from "./managed/create-service.ts";
import { bunSqliteManagedStackRepositoryLayer } from "./managed/sqlite-bun.ts";

export const runBunManagedDaemon = (): void => {
  void runManagedDaemon(
    ({ apiPort, releaseApiPort }) =>
      Layer.mergeAll(
        BunServices.layer,
        Layer.unwrap(releaseApiPort.pipe(Effect.as(BunHttpServer.layer({ port: apiPort })))),
      ),
    (socketPath) => BunHttpServer.layer({ idleTimeout: 0, unix: socketPath }),
    {
      createService: ({ stateRoot, ownerPid }) =>
        createManagedStackServiceWith(BunServices.layer, bunSqliteManagedStackRepositoryLayer, {
          stateRoot,
          ownerPid,
          publicationPollMs: 1,
        }),
    },
  );
};

if (import.meta.main) {
  runBunManagedDaemon();
}

export const managedDaemonEntryPoint = fileURLToPath(
  new URL("./managed-daemon-bun.ts", import.meta.url),
);
