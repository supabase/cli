import { NodeFileSystem, NodePath, NodeServices } from "@effect/platform-node";
import { createServer, type Server } from "node:net";
import { Effect, Layer } from "effect";
import { runSupervisor, supervisorTestStackLayer, type SupervisorPlatform } from "./supervisor.ts";
import { PORT_FIELDS } from "./PortCatalog.ts";
import { managedStackManagerLayer as makeManagerLayer } from "./managed/manager.ts";
import { gitConfigStoreLayer } from "./managed/git.ts";
import { controlTransportLayer, platformFactory } from "./platform-node.ts";

const managerLayer = (stateRoot: string) =>
  makeManagerLayer({ stateRoot }).pipe(
    Layer.provide(
      Layer.mergeAll(
        NodeFileSystem.layer,
        NodePath.layer,
        gitConfigStoreLayer,
        controlTransportLayer,
      ),
    ),
  );

const bindPort = (port: number): Effect.Effect<Server> =>
  Effect.callback((resume) => {
    const server = createServer((socket) => socket.destroy());
    const onError = (cause: Error) => resume(Effect.die(cause));
    server.once("error", onError);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", onError);
      resume(Effect.succeed(server));
    });
    return Effect.sync(() => server.close());
  });

const closePorts = (servers: ReadonlyArray<Server>): Effect.Effect<void> =>
  Effect.forEach(
    servers,
    (server) =>
      Effect.callback<void>((resume) => {
        if (!server.listening) {
          resume(Effect.void);
          return Effect.void;
        }
        server.close(() => resume(Effect.void));
        return Effect.void;
      }),
    { discard: true },
  );

const testRuntime = ({
  config,
  lease,
  mode,
}: Parameters<NonNullable<SupervisorPlatform["testRuntime"]>>[0]) =>
  Effect.gen(function* () {
    if (mode === "hold-start") {
      yield* Effect.never;
    }
    const servers: Array<Server> = [];
    if (mode !== "hold-reservations") {
      for (const field of PORT_FIELDS) {
        const port = config.ports[field];
        if (port === undefined) continue;
        yield* lease.release([field]);
        servers.push(yield* bindPort(port));
      }
    }
    yield* Effect.addFinalizer(() => closePorts(servers));
    return supervisorTestStackLayer(config);
  });

/** Thin Node child entrypoint shared by managed and ordinary detached starts. */
export const runNodeSupervisor = (): void => {
  void Effect.runPromise(
    runSupervisor({ platformFactory, managerLayer, testRuntime }).pipe(
      Effect.provide(NodeServices.layer),
      Effect.provide(NodeFileSystem.layer),
      Effect.provide(NodePath.layer),
      Effect.provide(gitConfigStoreLayer),
      Effect.provide(controlTransportLayer),
    ),
  );
};

export const runNodeDaemon = runNodeSupervisor;

if (import.meta.main) runNodeSupervisor();
