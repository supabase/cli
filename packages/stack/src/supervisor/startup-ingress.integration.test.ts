import { NodeServices } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import {
  Context,
  Crypto,
  Deferred,
  Effect,
  Exit,
  Fiber,
  FileSystem,
  Option,
  Path,
  Ref,
} from "effect";
import {
  request as requestHttp,
  createServer,
  type ClientRequest,
  type IncomingMessage,
  type ServerResponse,
  // oxlint-disable-next-line effecttsgo/node-builtin-import -- startup ingress protocol fixture.
} from "node:http";
import { deriveStackId } from "../identity/Identity.ts";
import type { StackError } from "../public/Errors.ts";
import { makeStackStateStore } from "../state/StackStateStore.ts";
import { bindHostListener, type HostListener } from "./HostListener.ts";
import { makeSupervisorIngress } from "./Ingress.ts";
import { makeSupervisor, type SupervisorRuntime } from "./Supervisor.ts";
import type { RuntimeDriver } from "../runtime/RuntimeDriver.ts";
import type { PlannedWorkload } from "../model/ExecutionPlan.ts";
import type { StackLogEntry } from "../public/Logs.ts";

const withPlatform = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.scoped(effect).pipe(Effect.provide(NodeServices.layer));

const response = (
  port: number,
  sent: Deferred.Deferred<void>,
  finished: Deferred.Deferred<void>,
  requestRef: { value?: ClientRequest },
) =>
  Effect.callback<{ readonly status: number; readonly body: string }, Error>((resume) => {
    const client = requestHttp({ host: "127.0.0.1", port, path: "/rest/v1/items" }, (incoming) => {
      const chunks: Buffer[] = [];
      incoming.on("data", (chunk: Buffer) => chunks.push(chunk));
      incoming.once("end", () =>
        resume(
          Effect.succeed({
            status: incoming.statusCode ?? 0,
            body: Buffer.concat(chunks).toString(),
          }).pipe(Effect.tap(() => Deferred.succeed(finished, undefined))),
        ),
      );
    });
    requestRef.value = client;
    client.once("error", (error) => resume(Effect.fail(error)));
    client.end(() => Deferred.doneUnsafe(sent, Effect.void));
    return Effect.sync(() => client.destroy());
  });

const backend = Effect.acquireRelease(
  Effect.callback<ReturnType<typeof createServer>, Error>((resume) => {
    const server = createServer((_request: IncomingMessage, result: ServerResponse) => {
      result.statusCode = 200;
      result.end("backend-ready");
    });
    server.once("error", (error) => resume(Effect.fail(error)));
    server.listen(0, "127.0.0.1", () => resume(Effect.succeed(server)));
    return Effect.sync(() => {
      if (server.listening) server.close();
    });
  }),
  (server) =>
    Effect.callback<void, never>((resume) => {
      if (!server.listening) return resume(Effect.void);
      server.close(() => resume(Effect.void));
    }),
);

const makeStartupFixture = () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const crypto = yield* Crypto.Crypto;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "supabase-startup-ingress-" });
    const identity = {
      projectRoot: root,
      branchContext: "ordinary-workspace",
      stackName: "startup-ingress",
    } as const;
    const stackId = yield* deriveStackId(identity);
    const store = yield* makeStackStateStore({ stateRoot: root });
    yield* store.initialize(stackId, {
      format: "supabase-stack-state-v1",
      identity,
      runtime: { kind: "native" },
      desiredLifecycle: "unconfigured",
      ports: [],
      privatePorts: [],
      secrets: {},
    });
    const context = Context.make(FileSystem.FileSystem, fs).pipe(
      Context.add(Path.Path, path),
      Context.add(Crypto.Crypto, crypto),
    );
    const listenerBound = yield* Deferred.make<HostListener, StackError>();
    const startEntered = yield* Deferred.make<void>();
    const releaseStart = yield* Deferred.make<void>();
    const activationCalls = yield* Ref.make(0);
    const service = yield* backend;
    const address = service.address();
    if (typeof address !== "object" || address === null)
      return yield* Effect.die("backend did not expose an address");

    const bindHost = (host: string, port: number, field: import("../public/Status.ts").PortField) =>
      bindHostListener(host, port, field).pipe(
        Effect.tap((listener) =>
          field === "api" ? Deferred.succeed(listenerBound, listener) : Effect.void,
        ),
      );
    const ingress = yield* makeSupervisorIngress({
      stackId,
      stateRoot: root,
      store,
      context,
      bindHost,
      apiMaterial: () =>
        Effect.succeed({
          publishableKey: "publishable",
          secretKey: "secret",
          anonJwt: "anon",
          serviceRoleJwt: "service",
        }),
    });
    const driver: RuntimeDriver = {
      observe: () => Effect.succeed([]),
      start: (key, _workload: PlannedWorkload) =>
        Effect.gen(function* () {
          if (key.workloadId === "database:database") {
            yield* Deferred.succeed(startEntered, undefined);
            yield* Deferred.await(releaseStart);
          }
          return { ...key, state: "ready" as const };
        }),
      stop: () => Effect.void,
      remove: () => Effect.void,
      cleanup: () => Effect.void,
      wipePersistentData: () => Effect.void,
    };
    const entry: StackLogEntry = {
      cursor: { opaque: "v1_1" },
      timestamp: "2026-01-01T00:00:00.000Z",
      source: "supervisor",
      stream: "internal",
      message: "startup",
    };
    const runtime: SupervisorRuntime = {
      driver,
      preflight: () => Effect.void,
      prepare: () => Effect.void,
      prefetch: () => Effect.void,
      artifacts: Effect.succeed([]),
      activate: () =>
        Ref.update(activationCalls, (count) => count + 1).pipe(
          Effect.andThen(Effect.succeed({ host: "127.0.0.1", port: address.port })),
        ),
      ingress,
      logStore: {
        path: "memory://startup-ingress",
        append: () => Effect.succeed(entry),
        read: () => Effect.succeed([entry]),
      },
    };
    const supervisor = yield* makeSupervisor({
      stackId,
      ownerSessionId: "startup-ingress-test",
      stateStore: store,
      context,
      runtime,
    });
    const start = supervisor
      .start({
        config: {
          listeners: {
            api: { enabled: true },
            database: { enabled: false },
            pooler: { enabled: false },
            studio: { enabled: false },
            mailUi: { enabled: false },
            smtp: { enabled: false },
            pop3: { enabled: false },
            functionsInspector: { enabled: false },
          },
        },
      })
      .pipe(Effect.tapCause((cause) => Deferred.failCause(listenerBound, cause)));
    return { listenerBound, startEntered, releaseStart, activationCalls, supervisor, start };
  });

describe("startup ingress", () => {
  it.live("holds requests during startup and forwards them after the service is ready", () =>
    withPlatform(
      Effect.gen(function* () {
        const fixture = yield* makeStartupFixture();
        const starting = yield* Effect.forkChild(fixture.start);
        const listener = yield* Deferred.await(fixture.listenerBound);
        if (listener.binding.kind !== "http") return yield* Effect.die("API listener is not HTTP");

        const requestsAccepted = yield* Deferred.make<void>();
        let acceptedCount = 0;
        const onRequest = () => {
          acceptedCount += 1;
          if (acceptedCount === 2) Deferred.doneUnsafe(requestsAccepted, Effect.void);
        };
        listener.binding.server.on("request", onRequest);
        const firstSent = yield* Deferred.make<void>();
        const secondSent = yield* Deferred.make<void>();
        const secondFinished = yield* Deferred.make<void>();
        const firstRequest: { value?: ClientRequest } = {};
        const first = yield* Effect.forkChild(
          response(listener.port, firstSent, yield* Deferred.make<void>(), firstRequest),
        );
        yield* Deferred.await(firstSent);
        const second = yield* Effect.forkChild(
          response(listener.port, secondSent, secondFinished, {}),
        );
        yield* Deferred.await(secondSent);
        yield* Deferred.await(requestsAccepted);
        yield* Deferred.await(fixture.startEntered);
        expect(Option.isNone(yield* Deferred.poll(secondFinished))).toBe(true);
        firstRequest.value?.destroy();
        yield* Deferred.succeed(fixture.releaseStart, undefined);

        expect(yield* Fiber.join(second)).toEqual({ status: 200, body: "backend-ready" });
        expect((yield* Fiber.join(starting)).lifecycle).toBe("running");
        expect(yield* Ref.get(fixture.activationCalls)).toBe(1);
        expect(Exit.isFailure(yield* Fiber.join(first).pipe(Effect.exit))).toBe(true);
        listener.binding.server.off("request", onRequest);
        yield* fixture.supervisor.destroy;
      }),
    ),
  );
});
