import { mkdir, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { BunServices } from "@effect/platform-bun";
import * as BunHttpServer from "@effect/platform-bun/BunHttpServer";
import { Effect } from "effect";
import { runManagedDaemon, type ManagedDaemonDependencies } from "./managed-daemon.ts";
import { createManagedStackServiceWith } from "./managed/create-service.ts";
import { bunSqliteManagedStackRepositoryLayer } from "./managed/sqlite-bun.ts";
import { platformFactory } from "./platform-bun.ts";
import { portFieldsForConfigInput } from "./ServicePorts.ts";

/** Marker written by the loopback bootstrap before the stack is published. */
export const MANAGED_DAEMON_TEST_PORT_MARKER = "managed-daemon-test-ports.json";

let loopbackServers: ReadonlyArray<Server> = [];

const closeLoopbackServers = async (): Promise<void> => {
  const servers = loopbackServers;
  loopbackServers = [];
  await Promise.all(
    servers.map(
      (server) =>
        new Promise<void>((resolve) => {
          if (!server.listening) {
            resolve();
            return;
          }
          server.close(() => resolve());
        }),
    ),
  );
};

const bindLoopbackPort = (port: number): Promise<Server> =>
  new Promise((resolve, reject) => {
    const server = createServer((socket) => socket.destroy());
    const onError = (error: Error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve(server);
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, "127.0.0.1");
  });

const noRuntimeDaemonServer: ManagedDaemonDependencies = {
  createService: ({ stateRoot, ownerPid }) =>
    createManagedStackServiceWith(BunServices.layer, bunSqliteManagedStackRepositoryLayer, {
      stateRoot,
      ownerPid,
      publicationPollMs: 1,
    }),
  runtimeBootstrap: async ({ stack, config, allocation, socketPath, testMode }) => {
    const fields = portFieldsForConfigInput(config);
    const fieldPorts = fields.flatMap((field): ReadonlyArray<readonly [typeof field, number]> => {
      const port = allocation.ports[field];
      return port === undefined ? [] : [[field, port]];
    });
    const servers: Array<Server> = [];
    try {
      if (testMode !== "hold-reservations") {
        for (const [field, port] of fieldPorts) {
          await Effect.runPromise(allocation.lease.release([field]));
          servers.push(await bindLoopbackPort(port));
        }
      }
      loopbackServers = servers;
    } catch (error) {
      await closeLoopbackServers();
      await Promise.all(
        servers.map(
          (server) =>
            new Promise<void>((resolve) => {
              server.close(() => resolve());
            }),
        ),
      );
      throw error;
    }
    const ports = Object.fromEntries(
      fields.flatMap((field): ReadonlyArray<readonly [string, number]> => {
        const port = allocation.ports[field];
        return port === undefined ? [] : [[field, port]];
      }),
    );
    await mkdir(stack.paths.runtime, { recursive: true });
    await writeFile(
      join(stack.paths.runtime, MANAGED_DAEMON_TEST_PORT_MARKER),
      JSON.stringify(ports),
      "utf8",
    );
    if (testMode === "fail-after-bind") {
      await closeLoopbackServers();
      throw new Error("loopback bootstrap failure");
    }
    return {
      pid: process.pid,
      socketPath,
      processIds: {},
      containerIds: {},
    };
  },
};

process.once("SIGINT", () => {
  void closeLoopbackServers();
});
process.once("SIGTERM", () => {
  void closeLoopbackServers();
});

export const runBunManagedDaemonTest = (): void => {
  void runManagedDaemon(
    platformFactory,
    (socketPath) => BunHttpServer.layer({ idleTimeout: 0, unix: socketPath }),
    noRuntimeDaemonServer,
  );
};

if (import.meta.main) {
  runBunManagedDaemonTest();
}

export const managedDaemonTestEntryPoint = fileURLToPath(
  new URL("./managed-daemon-test-bun.ts", import.meta.url),
);
