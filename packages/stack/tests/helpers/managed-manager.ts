import { Effect, Stream } from "effect";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  ManagedStackManagerShape,
  ManagedStackStartResult,
} from "../../src/managed/manager.ts";
import { managedStackManagerLayer } from "../../src/managed/manager.ts";
import type { ManagedPortIntentDocument } from "../../src/managed/model.ts";
import { acquireControl } from "../../src/managed/control.ts";
import { deriveStackId, ensureEnvironment } from "../../src/managed/environment.ts";
import { reservePortSet } from "../../src/PortAllocator.ts";
import type { Stack } from "../../src/Stack.ts";

export const cleanupRoots = (roots: Array<string>) => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
};

export const makeTemporaryRoot = (roots: Array<string>, prefix: string) => {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  return root;
};

export const setupManagedManager = (roots: Array<string>) => {
  const root = makeTemporaryRoot(roots, "managed-manager-test-");
  const workspace = join(root, "workspace");
  mkdirSync(workspace);
  const stateRoot = join(root, "state");
  const layer = managedStackManagerLayer({ stateRoot });
  return { layer, stateRoot, workspace };
};

export const controlStack = (): Stack["Service"] => ({
  getInfo: () =>
    Effect.succeed({
      url: "http://127.0.0.1",
      dbUrl: "postgres://127.0.0.1",
      publishableKey: "publishable",
      secretKey: "secret",
      anonJwt: "anon",
      serviceRoleJwt: "service",
      serviceEndpoints: {},
    }),
  start: () => Effect.void,
  stop: () => Effect.void,
  dispose: () => Effect.void,
  startService: () => Effect.void,
  stopService: () => Effect.void,
  restartService: () => Effect.void,
  reloadFunctions: () => Effect.void,
  reloadEdgeRuntime: () => Effect.void,
  getState: () => Effect.die("unused"),
  getAllStates: () => Effect.succeed([]),
  stateChanges: () => Effect.succeed(Stream.empty),
  allStateChanges: () => Stream.empty,
  waitReady: () => Effect.void,
  waitAllReady: () => Effect.void,
  subscribeLogs: () => Stream.empty,
  subscribeAllLogs: () => Stream.empty,
  logHistory: () => Effect.succeed([]),
  logHistoryAll: () => Effect.succeed([]),
});

export const automaticDocument = (
  field: "apiPort" | "studioPort" = "apiPort",
): ManagedPortIntentDocument => ({
  activeFields: field === "apiPort" ? ["apiPort", "dbPort"] : ["apiPort", "dbPort", field],
  document: {},
});

export const automaticRuntimeDocument = (): ManagedPortIntentDocument => ({
  activeFields: ["apiPort", "dbPort", "authPort"],
  document: {},
});

export const exactDocument = (
  field: "apiPort" | "studioPort",
  port: number,
): ManagedPortIntentDocument => ({
  activeFields: field === "apiPort" ? ["apiPort", "dbPort"] : ["apiPort", "dbPort", field],
  document: field === "apiPort" ? { api: { port } } : { studio: { port } },
});

export const exactCoreDocument = (apiPort: number, dbPort: number): ManagedPortIntentDocument => ({
  activeFields: ["apiPort", "dbPort"],
  document: { api: { port: apiPort }, db: { port: dbPort } },
});

const FREE_PORT_FIELDS = [
  "authPort",
  "postgrestPort",
  "postgrestAdminPort",
  "realtimePort",
] as const;

export const freePorts = (
  count: number,
): Effect.Effect<ReadonlyArray<number>, unknown, import("effect/Scope").Scope> =>
  Effect.gen(function* () {
    const lease = yield* reservePortSet(
      FREE_PORT_FIELDS.slice(0, count).map((field) => ({
        field,
        selection: { kind: "automatic" as const },
      })),
    );
    const ports = FREE_PORT_FIELDS.slice(0, count).flatMap((field) => {
      const port = lease.ports[field];
      return port === undefined ? [] : [port];
    });
    yield* lease.releaseAll;
    if (ports.length !== count) return yield* Effect.fail(new Error("missing free ports"));
    return ports;
  });

export const freePort = (): Effect.Effect<number, unknown, import("effect/Scope").Scope> =>
  Effect.gen(function* () {
    const [port] = yield* freePorts(1);
    if (port === undefined) return yield* Effect.fail(new Error("missing free port"));
    return port;
  });

export const listenExternal = (port: number): Promise<Server> =>
  new Promise((resolve, reject) => {
    const server = createServer((_request, response) => response.end("external"));
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve(server));
  });

export const closeExternal = (server: Server): Promise<void> =>
  new Promise((resolve, reject) => {
    server.close((error) => (error === undefined ? resolve() : reject(error)));
  });

/**
 * Control endpoints project two identity-hash bytes into `CONTROL_PORT_RANGE`,
 * so parallel test files can land on a port already owned by another live
 * stack's control server. Acquires control for a fresh directory under `base`,
 * retrying with a new directory (a new path-seeded identity, so a new port) on
 * a conflict until a wall-clock deadline, rethrowing the last conflict.
 */
export const acquireWorkspaceControl = (base: string, prefix = "workspace") =>
  Effect.gen(function* () {
    const deadline = Date.now() + 10_000;
    for (;;) {
      const workspace = mkdtempSync(join(base, `${prefix}-`));
      const environment = yield* ensureEnvironment(workspace);
      const stackId = deriveStackId(environment.identity, "default");
      const acquired = yield* acquireControl({ stackId }).pipe(
        Effect.map((ownership) => ({ ownership })),
        Effect.catch((error) =>
          error._tag === "ControlAddressConflictError" && Date.now() < deadline
            ? Effect.succeed(undefined)
            : Effect.fail(error),
        ),
      );
      if (acquired !== undefined) {
        return { workspace, environment, stackId, ownership: acquired.ownership };
      }
    }
  });

export const startWithOwner = (
  manager: ManagedStackManagerShape,
  workspacePath: string,
  portDocument: ManagedPortIntentDocument,
  lifecycle: "stopped" | "running" = "stopped",
  stackName = "default",
) =>
  Effect.gen(function* () {
    const environment = yield* ensureEnvironment(workspacePath);
    const stackId = deriveStackId(environment.identity, stackName);
    const ownership = yield* acquireControl({ stackId });
    if (ownership._tag !== "Owned") throw new Error("expected stack control ownership");
    return yield* manager.startStack({
      workspacePath,
      stackName,
      portDocument,
      ownership,
      lifecycle,
    });
  });

export const releaseLease = (result: ManagedStackStartResult): Effect.Effect<void> =>
  result.lease.releaseAll;
