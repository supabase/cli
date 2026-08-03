import { NodeServices } from "@effect/platform-node";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import { createServer } from "node:http";
import { Effect, Layer } from "effect";
import { runDaemon } from "./daemon.ts";
import { proxyWebSocketConnectorLayer } from "./ProxyWebSocket.node.ts";

runDaemon(
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
      proxyWebSocketConnectorLayer,
    ),
  (socketPath) =>
    NodeHttpServer.layer(() => createServer(), { path: socketPath }).pipe(Layer.orDie),
);
