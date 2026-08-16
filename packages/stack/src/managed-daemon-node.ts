import { NodeServices } from "@effect/platform-node";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { Effect, Layer } from "effect";
import { runManagedDaemon } from "./managed-daemon.ts";
import { createManagedStackServiceWith } from "./managed/create-service.ts";
import { nodeSqliteManagedStackRepositoryLayer } from "./managed/sqlite-node.ts";

export const runNodeManagedDaemon = (): void => {
  void runManagedDaemon(
    ({ apiPort, releaseApiPort }) =>
      Layer.mergeAll(
        NodeServices.layer,
        Layer.unwrap(
          releaseApiPort.pipe(
            Effect.as(
              NodeHttpServer.layer(() => createServer(), { port: apiPort }).pipe(Layer.orDie),
            ),
          ),
        ),
      ),
    (socketPath) =>
      NodeHttpServer.layer(() => createServer(), { path: socketPath }).pipe(Layer.orDie),
    {
      createService: ({ stateRoot, ownerPid }) =>
        createManagedStackServiceWith(NodeServices.layer, nodeSqliteManagedStackRepositoryLayer, {
          stateRoot,
          ownerPid,
          publicationPollMs: 1,
        }),
    },
  );
};

if (import.meta.main) {
  runNodeManagedDaemon();
}

export const managedDaemonEntryPoint = fileURLToPath(
  new URL("./managed-daemon-node.ts", import.meta.url),
);
