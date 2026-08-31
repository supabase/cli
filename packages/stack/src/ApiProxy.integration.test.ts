// oxlint-disable effecttsgo/async-function, effecttsgo/global-fetch, effecttsgo/new-promise, effecttsgo/node-builtin-import -- The proxy integration test owns native HTTP/WebSocket listeners and exercises the public network surface.
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeSocket from "@effect/platform-node/NodeSocket";
import * as BunHttpServer from "@effect/platform-bun/BunHttpServer";
import { Buffer } from "node:buffer";
import * as http from "node:http";
import { Deferred, Effect, Layer, ManagedRuntime, Predicate } from "effect";
import { FetchHttpClient } from "effect/unstable/http";
import { createClient } from "@supabase/supabase-js";
import { describe, expect, test } from "vitest";
import { ApiProxy, type ProxyConfig } from "./ApiProxy.ts";
import { StackServiceActivator } from "./ServiceActivation.ts";

const PUBLISHABLE_KEY = "sb_publishable_testkey";

interface WebSocketBackend {
  readonly port: number;
  readonly request: () => { readonly url: string; readonly host: string | undefined } | undefined;
  readonly messageIsBinary: () => boolean | undefined;
  readonly stop: () => Promise<void>;
}

const rawDataToUtf8 = (data: NodeSocket.NodeWS.RawData): string => {
  if (Buffer.isBuffer(data)) return data.toString("utf8");
  if (Array.isArray(data)) return Buffer.concat(data).toString("utf8");
  return Buffer.from(data).toString("utf8");
};

function startWebSocketBackend(
  onMessage?: (websocket: NodeSocket.NodeWS.WebSocket, data: NodeSocket.NodeWS.RawData) => void,
): Promise<WebSocketBackend> {
  return new Promise((resolve, reject) => {
    const server = http.createServer();
    const webSocketServer = new NodeSocket.NodeWS.WebSocketServer({
      noServer: true,
      handleProtocols: (protocols) => protocols.values().next().value ?? false,
    });
    let requestDetails: { readonly url: string; readonly host: string | undefined } | undefined;
    let messageIsBinary: boolean | undefined;
    const clients = new Set<NodeSocket.NodeWS.WebSocket>();

    server.on("upgrade", (request, socket, head) => {
      webSocketServer.handleUpgrade(request, socket, head, (websocket) => {
        clients.add(websocket);
        websocket.once("close", () => clients.delete(websocket));
        requestDetails = { url: request.url ?? "", host: request.headers.host };
        websocket.on("message", (data, isBinary) => {
          messageIsBinary = isBinary;
          if (onMessage === undefined) {
            websocket.send(data, { binary: isBinary });
          } else {
            onMessage(websocket, data);
          }
        });
      });
    });
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("Unexpected server address"));
        return;
      }
      resolve({
        port: address.port,
        request: () => requestDetails,
        messageIsBinary: () => messageIsBinary,
        stop: () =>
          new Promise<void>((res, rej) => {
            for (const client of clients) client.terminate();
            webSocketServer.close((error) => {
              if (error) {
                rej(error);
                return;
              }
              server.close((closeError) => (closeError ? rej(closeError) : res()));
            });
          }),
      });
    });
  });
}

function buildProxyLayer(config: ProxyConfig): Layer.Layer<ApiProxy, never, never> {
  return ApiProxy.layer(config).pipe(
    Layer.provide(NodeHttpServer.layer(() => http.createServer(), { port: 0 }).pipe(Layer.orDie)),
    Layer.provide(FetchHttpClient.layer),
    Layer.provide(StackServiceActivator.noop),
  ) as Layer.Layer<ApiProxy, never, never>;
}

function buildBunProxyLayer(
  config: ProxyConfig,
  activator: Layer.Layer<StackServiceActivator> = StackServiceActivator.noop,
): Layer.Layer<ApiProxy, never, never> {
  return ApiProxy.layer(config).pipe(
    Layer.provide(BunHttpServer.layer({ hostname: "127.0.0.1", port: 0 })),
    Layer.provide(FetchHttpClient.layer),
    Layer.provide(activator),
  ) as Layer.Layer<ApiProxy, never, never>;
}

const proxyConfigFor = (backendPort: number): ProxyConfig => ({
  listenPort: 0,
  gotruePort: backendPort,
  postgrestPort: backendPort,
  postgrestAdminPort: backendPort,
  edgeRuntimePort: backendPort,
  realtimePort: backendPort,
  realtimeTenantId: "realtime-test",
  storagePort: backendPort,
  pgmetaPort: backendPort,
  analyticsPort: backendPort,
  poolerPort: backendPort,
  studioPort: backendPort,
  publishableKey: PUBLISHABLE_KEY,
  secretKey: "sb_secret_testkey",
  anonJwt: "test-anon-jwt-token",
  serviceRoleJwt: "test-service-role-jwt-token",
});

const clientAddress = (port: number): string =>
  `ws://127.0.0.1:${port}/realtime/v1/websocket?apikey=${PUBLISHABLE_KEY}&vsn=1.0.0`;

const awaitClientOpen = (client: NodeSocket.NodeWS.WebSocket): Promise<void> =>
  new Promise((resolve, reject) => {
    client.once("open", resolve);
    client.once("error", reject);
  });

const awaitClientClose = (
  client: NodeSocket.NodeWS.WebSocket,
): Promise<{ readonly code: number; readonly reason: string }> =>
  new Promise((resolve, reject) => {
    client.once("close", (code, reason) => resolve({ code, reason: rawDataToUtf8(reason) }));
    client.once("error", reject);
  });

async function openNodeProxyWebSocket(onMessage?: Parameters<typeof startWebSocketBackend>[0]) {
  const backend = await startWebSocketBackend(onMessage);
  const runtime = ManagedRuntime.make(buildProxyLayer(proxyConfigFor(backend.port)));
  const proxy = await runtime.runPromise(ApiProxy);
  const address = proxy.address;
  if (!Predicate.isTagged(address, "TcpAddress")) throw new Error("Expected TCP proxy address");
  const client = new NodeSocket.NodeWS.WebSocket(clientAddress(address.port), "realtime-v1");
  return {
    backend,
    runtime,
    client,
    dispose: async () => {
      if (client.readyState !== NodeSocket.NodeWS.WebSocket.CLOSED) client.terminate();
      await runtime.dispose();
      await backend.stop();
    },
  };
}

describe("ApiProxy realtime websocket", () => {
  test("forwards frames with the backend path, tenant host, and projected query key", async () => {
    const fixture = await openNodeProxyWebSocket();
    const payload = '["hello realtime"]';
    try {
      await awaitClientOpen(fixture.client);
      const echoed = new Promise<{ readonly text: string; readonly isBinary: boolean }>(
        (resolve, reject) => {
          fixture.client.once("message", (data, isBinary) =>
            resolve({ text: rawDataToUtf8(data), isBinary }),
          );
          fixture.client.once("error", reject);
        },
      );
      fixture.client.send(payload);

      expect(await echoed).toEqual({ text: payload, isBinary: false });
      expect(fixture.backend.messageIsBinary()).toBe(false);
      expect(fixture.backend.request()).toEqual({
        url: "/socket/websocket?apikey=test-anon-jwt-token&vsn=1.0.0",
        host: "realtime-test",
      });
    } finally {
      await fixture.dispose();
    }
  });

  test(
    "forwards a clean backend close code and reason to the client",
    { timeout: 5_000 },
    async () => {
      const fixture = await openNodeProxyWebSocket((websocket) => {
        websocket.close(1000, "backend shutdown");
      });
      try {
        const closed = awaitClientClose(fixture.client);
        await awaitClientOpen(fixture.client);
        fixture.client.send("close");

        await expect(closed).resolves.toEqual({ code: 1000, reason: "backend shutdown" });
      } finally {
        await fixture.dispose();
      }
    },
  );

  test(
    "forwards an application backend close code and reason to the client",
    { timeout: 5_000 },
    async () => {
      const fixture = await openNodeProxyWebSocket((websocket) => {
        websocket.close(1013, "service restarting");
      });
      try {
        const closed = awaitClientClose(fixture.client);
        await awaitClientOpen(fixture.client);
        fixture.client.send("close");

        await expect(closed).resolves.toEqual({ code: 1013, reason: "service restarting" });
      } finally {
        await fixture.dispose();
      }
    },
  );

  test(
    "normalizes an unsendable backend close code before forwarding it",
    { timeout: 5_000 },
    async () => {
      const fixture = await openNodeProxyWebSocket((websocket) => {
        websocket.terminate();
      });
      try {
        const closed = awaitClientClose(fixture.client);
        await awaitClientOpen(fixture.client);
        fixture.client.send("close");

        await expect(closed).resolves.toEqual({
          code: 1011,
          reason: "realtime backend connection lost",
        });
      } finally {
        await fixture.dispose();
      }
    },
  );

  (typeof Bun === "undefined" ? test.skip : test)(
    "forwards a Phoenix join from supabase-js after delayed Bun activation",
    { timeout: 15_000 },
    async () => {
      const activationGate = Deferred.makeUnsafe<void>();
      let joinReceived: (() => void) | undefined;
      const join = new Promise<void>((resolve) => {
        joinReceived = resolve;
      });
      const backend = await startWebSocketBackend((websocket, data) => {
        const message = JSON.parse(rawDataToUtf8(data)) as [
          string | null,
          string | null,
          string,
          string,
          { readonly config?: { readonly postgres_changes?: unknown } },
        ];
        if (message[3] !== "phx_join") return;
        joinReceived?.();
        websocket.send(
          JSON.stringify([
            message[0],
            message[1],
            message[2],
            "phx_reply",
            { response: {}, status: "ok" },
          ]),
        );
      });
      const config = proxyConfigFor(backend.port);
      let transportConnected: (() => void) | undefined;
      const transport = new Promise<void>((resolve) => {
        transportConnected = resolve;
      });
      const runtime = ManagedRuntime.make(
        buildBunProxyLayer(
          config,
          Layer.succeed(StackServiceActivator, {
            activate: () => Deferred.await(activationGate),
          }),
        ),
      );
      const proxy = await runtime.runPromise(ApiProxy);
      const address = proxy.address;
      if (!Predicate.isTagged(address, "TcpAddress")) throw new Error("Expected TCP proxy address");
      const client = createClient(`http://127.0.0.1:${address.port}`, PUBLISHABLE_KEY, {
        realtime: {
          timeout: 2_000,
          logger: (kind, message) => {
            if (kind === "transport" && message.startsWith("connected to")) {
              transportConnected?.();
              transportConnected = undefined;
            }
          },
        },
      });
      let channel: ReturnType<typeof client.channel> | undefined;
      try {
        const subscribed = new Promise<void>((resolve, reject) => {
          channel = client.channel("bun-public-surface").subscribe((status) => {
            if (status === "SUBSCRIBED") resolve();
            else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT" || status === "CLOSED") {
              reject(new Error(`Unexpected realtime status: ${status}`));
            }
          });
        });
        await transport;
        expect(backend.request()).toBeUndefined();
        Deferred.doneUnsafe(activationGate, Effect.void);
        await join;
        await subscribed;
        expect(backend.request()).toEqual({
          url: "/socket/websocket?apikey=test-anon-jwt-token&vsn=2.0.0",
          host: "realtime-test",
        });
      } finally {
        if (channel !== undefined) await client.removeChannel(channel);
        await client.removeAllChannels();
        await runtime.dispose();
        await backend.stop();
      }
    },
  );
});
