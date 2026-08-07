import { NodeServices } from "@effect/platform-node";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import { createServer } from "node:http";
import { Effect, Layer } from "effect";
import { runDaemon } from "./daemon.ts";

// Live child-process entrypoint for Node Effect consumers. The internal Node platform adapter
// resolves this module by file URL and passes its filesystem path to daemonLayer, so it is
// deliberately not a package export. The `knip.entry` declaration in package.json preserves this
// file-URL-only reachability; see the matching note in node.ts.
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
    ),
  (socketPath) =>
    NodeHttpServer.layer(() => createServer(), { path: socketPath }).pipe(Layer.orDie),
);
