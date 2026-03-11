import { BunServices } from "@effect/platform-bun";
import * as BunHttpServer from "@effect/platform-bun/BunHttpServer";
import { Layer } from "effect";
import { runDaemon } from "./daemon.ts";

runDaemon(
  (apiPort) => Layer.mergeAll(BunServices.layer, BunHttpServer.layer({ port: apiPort })),
  (socketPath) => BunHttpServer.layer({ unix: socketPath }),
);
