import { BunServices } from "@effect/platform-bun";
import * as BunHttpServer from "@effect/platform-bun/BunHttpServer";
import { ServiceNotFoundError, type LogEntry } from "@supabase/process-compose";
import { Duration, Effect, Layer, ManagedRuntime, Stream } from "effect";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { DaemonServer } from "./DaemonServer.ts";
import { RemoteStack } from "./RemoteStack.ts";
import { Stack, type StackInfo } from "./Stack.ts";
import { StackServiceState } from "./StackServiceState.ts";

const IDLE_TIMEOUT_WINDOW = Duration.seconds(11);

const MOCK_INFO: StackInfo = {
  url: "http://127.0.0.1:54321",
  dbUrl: "postgresql://postgres:postgres@127.0.0.1:54322/postgres",
  publishableKey: "pk_test",
  secretKey: "sk_test",
  anonJwt: "anon_jwt",
  serviceRoleJwt: "service_role_jwt",
  dockerContainerNames: ["supabase-postgres-54321"],
  serviceEndpoints: {},
};

const POSTGRES_STATE = new StackServiceState({
  name: "postgres",
  status: "Running",
  pid: 1234,
  exitCode: null,
  restartCount: 0,
  startedAt: Date.now(),
  error: null,
});

const DELAYED_LOG: LogEntry = {
  timestamp: 1000,
  service: "postgres",
  stream: "stdout",
  line: "hello from delayed log",
};

function makeSocketFixture() {
  const dir = mkdtempSync(join(tmpdir(), "supabase-"));
  return {
    dir,
    socketPath: join(dir, "d.sock"),
  };
}

function makeStackLayer(opts: {
  subscribeAllLogs: (services?: ReadonlyArray<string>) => Stream.Stream<LogEntry>;
  subscribeLogs: (name: string) => Stream.Stream<LogEntry>;
}): Layer.Layer<Stack> {
  return Layer.succeed(Stack, {
    getInfo: () => Effect.succeed(MOCK_INFO),
    start: () => Effect.void,
    stop: () => Effect.void,
    dispose: () => Effect.void,
    startService: (name: string) =>
      name === "postgres" ? Effect.void : Effect.fail(new ServiceNotFoundError({ name })),
    stopService: (name: string) =>
      name === "postgres" ? Effect.void : Effect.fail(new ServiceNotFoundError({ name })),
    restartService: (name: string) =>
      name === "postgres" ? Effect.void : Effect.fail(new ServiceNotFoundError({ name })),
    getState: (name: string) =>
      name === "postgres"
        ? Effect.succeed(POSTGRES_STATE)
        : Effect.fail(new ServiceNotFoundError({ name })),
    getAllStates: () => Effect.succeed([POSTGRES_STATE]),
    stateChanges: (name: string) =>
      name === "postgres"
        ? Effect.succeed(Stream.make(POSTGRES_STATE))
        : Effect.fail(new ServiceNotFoundError({ name })),
    allStateChanges: () => Stream.make(POSTGRES_STATE),
    waitReady: (name: string) =>
      name === "postgres" ? Effect.void : Effect.fail(new ServiceNotFoundError({ name })),
    waitAllReady: () => Effect.void,
    subscribeLogs: opts.subscribeLogs,
    subscribeAllLogs: opts.subscribeAllLogs,
    logHistory: (name: string) => Effect.succeed(name === "postgres" ? [DELAYED_LOG] : []),
    logHistoryAll: () => Effect.succeed([DELAYED_LOG]),
  });
}

function buildUnixDaemonLayer(
  stackLayer: Layer.Layer<Stack>,
  socketPath: string,
): Layer.Layer<DaemonServer, never, never> {
  return DaemonServer.layer.pipe(
    Layer.provide(stackLayer),
    Layer.provide(
      Layer.mergeAll(BunServices.layer, BunHttpServer.layer({ idleTimeout: 0, unix: socketPath })),
    ),
  ) as Layer.Layer<DaemonServer, never, never>;
}

describe("Unix socket SSE integration", () => {
  test(
    "daemon keeps idle logs SSE open past Bun's default timeout",
    { timeout: 20_000 },
    async () => {
      const { dir, socketPath } = makeSocketFixture();
      const delayedLogs = () =>
        Stream.fromEffect(Effect.delay(Effect.succeed(DELAYED_LOG), IDLE_TIMEOUT_WINDOW));
      const runtime = ManagedRuntime.make(
        buildUnixDaemonLayer(
          makeStackLayer({
            subscribeLogs: () => delayedLogs(),
            subscribeAllLogs: () => delayedLogs(),
          }),
          socketPath,
        ),
      );

      try {
        await runtime.runPromise(DaemonServer.asEffect());

        const res = await fetch("http://localhost/logs", { unix: socketPath } as RequestInit);

        expect(res.status).toBe(200);
        expect(res.headers.get("content-type")).toBe("text/event-stream");

        const text = await res.text();
        expect(text).toContain("event: log");
        expect(text).toContain(DELAYED_LOG.line);
      } finally {
        await runtime.dispose();
        rmSync(dir, { force: true, recursive: true });
      }
    },
  );

  test(
    "RemoteStack receives delayed logs over a Unix socket after an idle period",
    { timeout: 20_000 },
    async () => {
      const { dir, socketPath } = makeSocketFixture();
      const delayedLogs = () =>
        Stream.fromEffect(Effect.delay(Effect.succeed(DELAYED_LOG), IDLE_TIMEOUT_WINDOW));
      const serverRuntime = ManagedRuntime.make(
        buildUnixDaemonLayer(
          makeStackLayer({
            subscribeLogs: () => delayedLogs(),
            subscribeAllLogs: () => delayedLogs(),
          }),
          socketPath,
        ),
      );
      const clientRuntime = ManagedRuntime.make(RemoteStack.layer(socketPath));

      try {
        await serverRuntime.runPromise(DaemonServer.asEffect());

        const entries = await clientRuntime.runPromise(
          Effect.flatMap(Stack.asEffect(), (stack) =>
            stack.subscribeAllLogs().pipe(Stream.take(1), Stream.runCollect),
          ),
        );

        expect(entries).toHaveLength(1);
        expect(entries[0]).toEqual(DELAYED_LOG);
      } finally {
        await clientRuntime.dispose();
        await serverRuntime.dispose();
        rmSync(dir, { force: true, recursive: true });
      }
    },
  );
});
