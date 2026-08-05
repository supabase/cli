import { BunServices } from "@effect/platform-bun";
import * as BunHttpServer from "@effect/platform-bun/BunHttpServer";
import { fileURLToPath } from "node:url";
import { Effect, Layer } from "effect";
import type { PlatformFactory } from "./createStack.ts";
import { UnixHttpClient, UnixHttpClientError } from "./UnixHttpClient.ts";

interface BunUnixRequestInit extends RequestInit {
  readonly unix: string;
}

export const unixHttpClientLayer = Layer.succeed(UnixHttpClient, {
  request: (socketPath, path, init) =>
    Effect.tryPromise({
      try: () => {
        const requestInit: BunUnixRequestInit = { ...init, unix: socketPath };
        return fetch(`http://localhost${path}`, requestInit);
      },
      catch: (cause) => new UnixHttpClientError({ socketPath, path, cause }),
    }),
});

export const platformFactory: PlatformFactory = ({ apiPort, releaseApiPort }) =>
  Layer.mergeAll(
    BunServices.layer,
    Layer.unwrap(releaseApiPort.pipe(Effect.as(BunHttpServer.layer({ port: apiPort })))),
  );

/** Internal source-mode child target. Compiled CLI dispatch still uses the daemon-bun export. */
export const daemonEntryPoint = fileURLToPath(new URL("./daemon-bun.ts", import.meta.url));
