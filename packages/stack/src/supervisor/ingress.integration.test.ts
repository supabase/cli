import { NodeServices } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import { Context, Crypto, Effect, Exit, FileSystem, Path } from "effect";
// oxlint-disable-next-line effecttsgo/node-builtin-import
import {
  createServer as createHttpServer,
  request as requestHttp,
  type IncomingMessage,
  type ServerResponse,
  // oxlint-disable-next-line effecttsgo/node-builtin-import
} from "node:http";
import { deriveStackId, type StackIdentity } from "../identity/Identity.ts";
import { compileStack } from "../model/Compiler.ts";
import { GatewayActivationError, StackPreparationError } from "../public/Errors.ts";
import { makeStackStateStore } from "../state/StackStateStore.ts";
import type { PersistedStackState } from "../state/StackState.ts";
import { makePortRegistry } from "../state/PortRegistry.ts";
import { makeSupervisorIngress } from "./Ingress.ts";
import { privateBindingIntentsFor } from "../runtime/WorkloadRuntimeSpec.ts";

const identity: StackIdentity = {
  projectRoot: "/tmp/supabase-ingress",
  checkoutRoot: "/tmp/supabase-ingress",
  workspaceId: "/tmp/supabase-ingress",
  checkoutId: "/tmp/supabase-ingress",
  branchContext: "ordinary-workspace",
  localProjectKey: ".",
  stackName: "ingress",
};

const run = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.scoped(effect).pipe(Effect.provide(NodeServices.layer));

const closeServer = (server: ReturnType<typeof createHttpServer>): Effect.Effect<void> =>
  Effect.callback<void>((resume) => {
    if (!server.listening) return resume(Effect.void);
    server.close(() => resume(Effect.void));
  });

const listenBackend = (server: ReturnType<typeof createHttpServer>) =>
  Effect.acquireRelease(
    Effect.callback<void, Error>((resume) => {
      server.once("error", (error) => resume(Effect.fail(error)));
      server.listen(0, "127.0.0.1", () => resume(Effect.void));
    }),
    () => closeServer(server),
  ).pipe(Effect.as(server));

const request = (port: number, path = "/rest/v1/items", method = "GET") =>
  Effect.callback<{ readonly status: number; readonly body: string }, Error>((resume) => {
    const client = requestHttp(
      { host: "127.0.0.1", port, path, method },
      (response: IncomingMessage) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.once("end", () =>
          resume(
            Effect.succeed({
              status: response.statusCode ?? 0,
              body: Buffer.concat(chunks).toString(),
            }),
          ),
        );
      },
    );
    client.once("error", (error) => resume(Effect.fail(error)));
    client.end();
    return Effect.sync(() => client.destroy());
  });

describe("Supervisor ingress", () => {
  it.live("adopts a coordinated listener and forwards a public request", () =>
    run(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const crypto = yield* Crypto.Crypto;
        const context = Context.make(FileSystem.FileSystem, fs).pipe(
          Context.add(Path.Path, path),
          Context.add(Crypto.Crypto, crypto),
        );
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "supabase-ingress-" });
        const stackIdentity = {
          ...identity,
          projectRoot: root,
          checkoutRoot: root,
          workspaceId: root,
          checkoutId: root,
        };
        const stackId = yield* deriveStackId(stackIdentity);
        const compiled = yield* compileStack({
          projectRoot: root,
          runtime: { kind: "native" },
          config: {
            capabilities: {
              auth: { enabled: false },
              realtime: { enabled: false },
              storage: { enabled: false },
              functions: { enabled: false },
              studio: { enabled: false },
              mail: { enabled: false },
              analytics: { enabled: false },
              pooler: { enabled: false },
            },
            listeners: {
              database: { enabled: false },
              pooler: { enabled: false },
              studio: { enabled: false },
              mailUi: { enabled: false },
              smtp: { enabled: false },
              pop3: { enabled: false },
              functionsInspector: { enabled: false },
            },
          },
        });
        const store = yield* makeStackStateStore({ stateRoot: root });
        yield* store.initialize(stackId, {
          format: "supabase-stack-state-v1",
          identity: { ...stackIdentity, stackId },
          runtime: { kind: "native" },
          desiredLifecycle: "running",
          definition: compiled.definition,
          inputFingerprint: compiled.inputFingerprint,
          ports: [{ field: "api", port: 55432, intent: "automatic" }],
          privatePorts: privateBindingIntentsFor(compiled.executionPlan).map((binding, index) => ({
            ...binding,
            port: 30000 + index,
          })),
          secrets: {},
        });
        const registry = yield* makePortRegistry({ stateRoot: root, store });
        const ingress = yield* makeSupervisorIngress({
          stackId,
          registry,
          store,
          context,
          apiMaterial: () =>
            Effect.succeed({
              publishableKey: "sb_publishable_test",
              secretKey: "sb_secret_test",
              anonJwt: "anon-jwt",
              serviceRoleJwt: "service-jwt",
            }),
        });
        const input = {
          stackId,
          desiredLifecycle: "running" as const,
          state: yield* store.read(stackId).pipe(Effect.map((value) => value!)),
          definition: compiled.definition,
          inputFingerprint: compiled.inputFingerprint,
          secrets: {},
          plan: compiled.executionPlan,
        };
        const reservation = yield* ingress.acquire(input);
        expect(reservation.hostListeners).toHaveLength(1);
        const backend = yield* listenBackend(
          createHttpServer((_request: IncomingMessage, response: ServerResponse) => {
            response.statusCode = 200;
            response.end("forwarded");
          }),
        );
        const backendAddress = backend.address();
        if (typeof backendAddress !== "object" || backendAddress === null)
          return yield* Effect.die("backend did not expose an address");
        yield* ingress.open(input, reservation, (capability) =>
          Effect.succeed({
            capability,
            endpoint: { host: "127.0.0.1", port: backendAddress.port },
          }),
        );
        const api = reservation.assignments.api;
        if (api === undefined) return yield* Effect.die("API listener was not assigned");
        const response = yield* request(api.port);
        expect(response.status).toBe(200);
        expect(response.body).toBe("forwarded");
        yield* ingress.close;
      }),
    ),
  );

  it.live("rejects incomplete persisted gateway material before opening", () =>
    run(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const crypto = yield* Crypto.Crypto;
        const context = Context.make(FileSystem.FileSystem, fs).pipe(
          Context.add(Path.Path, path),
          Context.add(Crypto.Crypto, crypto),
        );
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "supabase-ingress-material-" });
        const stackId = yield* deriveStackId({
          ...identity,
          projectRoot: root,
          checkoutRoot: root,
          workspaceId: root,
          checkoutId: root,
        });
        const compiled = yield* compileStack({
          projectRoot: root,
          runtime: { kind: "native" },
          config: { capabilities: { rest: {} } },
        });
        const store = yield* makeStackStateStore({ stateRoot: root });
        yield* store.initialize(stackId, {
          format: "supabase-stack-state-v1",
          identity: {
            ...identity,
            projectRoot: root,
            checkoutRoot: root,
            workspaceId: root,
            checkoutId: root,
            stackId,
          },
          runtime: { kind: "native" },
          desiredLifecycle: "running",
          definition: compiled.definition,
          inputFingerprint: compiled.inputFingerprint,
          ports: [
            { field: "api", port: 55433, intent: "automatic" },
            { field: "database", port: 55436, intent: "automatic" },
            { field: "pooler", port: 55437, intent: "automatic" },
          ] as const,
          privatePorts: privateBindingIntentsFor(compiled.executionPlan).map((binding, index) => ({
            ...binding,
            port: 30100 + index,
          })),
          secrets: {},
        });
        const registry = yield* makePortRegistry({ stateRoot: root, store });
        const ingress = yield* makeSupervisorIngress({ stackId, registry, store, context });
        const state = yield* store.read(stackId).pipe(Effect.map((value) => value!));
        const reservation = yield* ingress.acquire({
          stackId,
          desiredLifecycle: "running",
          state,
          definition: compiled.definition,
          inputFingerprint: compiled.inputFingerprint,
          secrets: {},
          plan: compiled.executionPlan,
        });
        const failed = yield* ingress
          .open(
            {
              stackId,
              desiredLifecycle: "running",
              state,
              definition: compiled.definition,
              inputFingerprint: compiled.inputFingerprint,
              secrets: {},
              plan: compiled.executionPlan,
            },
            reservation,
            () => Effect.fail(new GatewayActivationError({ message: "not reached" })),
          )
          .pipe(Effect.exit);
        expect(Exit.isFailure(failed)).toBe(true);
      }),
    ),
  );

  it.live("opens non-API listeners without resolving API gateway material", () =>
    run(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const crypto = yield* Crypto.Crypto;
        const context = Context.make(FileSystem.FileSystem, fs).pipe(
          Context.add(Path.Path, path),
          Context.add(Crypto.Crypto, crypto),
        );
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "supabase-ingress-no-api-" });
        const stackIdentity = {
          ...identity,
          projectRoot: root,
          checkoutRoot: root,
          workspaceId: root,
          checkoutId: root,
        };
        const stackId = yield* deriveStackId(stackIdentity);
        const compiled = yield* compileStack({
          projectRoot: root,
          runtime: { kind: "native" },
          config: {
            capabilities: {
              rest: { enabled: false },
              auth: { enabled: false },
              realtime: { enabled: false },
              storage: { enabled: false },
              functions: { enabled: false },
              studio: { enabled: false },
              mail: { enabled: false },
              analytics: { enabled: false },
              pooler: { enabled: false },
            },
            listeners: {
              api: { enabled: false },
              database: { enabled: true },
              pooler: { enabled: false },
              studio: { enabled: false },
              mailUi: { enabled: false },
              smtp: { enabled: false },
              pop3: { enabled: false },
              functionsInspector: { enabled: false },
            },
          },
        });
        const store = yield* makeStackStateStore({ stateRoot: root });
        const persisted: PersistedStackState = {
          format: "supabase-stack-state-v1" as const,
          identity: { ...stackIdentity, stackId },
          runtime: { kind: "native" as const },
          desiredLifecycle: "running" as const,
          definition: compiled.definition,
          inputFingerprint: compiled.inputFingerprint,
          ports: [{ field: "database", port: 55434, intent: "automatic" }] as const,
          privatePorts: privateBindingIntentsFor(compiled.executionPlan).map((binding, index) => ({
            ...binding,
            port: 30200 + index,
          })),
          secrets: {},
        };
        yield* store.initialize(stackId, persisted);
        const registry = yield* makePortRegistry({ stateRoot: root, store });
        const ingress = yield* makeSupervisorIngress({
          stackId,
          registry,
          store,
          context,
          apiMaterial: () =>
            Effect.fail(new StackPreparationError({ message: "API material must not resolve" })),
        });
        const input = {
          stackId,
          desiredLifecycle: "running" as const,
          state: persisted,
          definition: compiled.definition,
          inputFingerprint: compiled.inputFingerprint,
          secrets: {},
          plan: compiled.executionPlan,
        };
        const reservation = yield* ingress.acquire(input);
        expect(reservation.assignments.api).toBeUndefined();
        expect(reservation.assignments.database?.port).toEqual(expect.any(Number));
        expect(reservation.privateAssignments).toEqual(
          expect.arrayContaining([
            { workloadId: "database:database", binding: "primary", port: expect.any(Number) },
          ]),
        );
        yield* ingress.open(input, reservation, () =>
          Effect.fail(new GatewayActivationError({ message: "not reached" })),
        );
        yield* ingress.close;
      }),
    ),
  );

  it.live("serves accepted Auth templates locally with live content and no activation", () =>
    run(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const crypto = yield* Crypto.Crypto;
        const context = Context.make(FileSystem.FileSystem, fs).pipe(
          Context.add(Path.Path, path),
          Context.add(Crypto.Crypto, crypto),
        );
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "supabase-ingress-template-" });
        const stackIdentity = {
          ...identity,
          projectRoot: root,
          checkoutRoot: root,
          workspaceId: root,
          checkoutId: root,
        };
        const stackId = yield* deriveStackId(stackIdentity);
        const templatePath = path.join(root, "templates", "confirmation.html");
        const outsideRoot = yield* fs.makeTempDirectoryScoped({
          prefix: "supabase-ingress-outside-",
        });
        const outsidePath = path.join(outsideRoot, "outside.html");
        yield* fs.makeDirectory(path.join(root, "templates"), { recursive: true });
        yield* fs.writeFileString(templatePath, "first");
        const compiled = yield* compileStack({
          projectRoot: root,
          runtime: { kind: "native" },
          config: {
            capabilities: {
              rest: { enabled: false },
              auth: {
                settings: {
                  email: {
                    template: { confirmation: { content_path: "templates/confirmation.html" } },
                  },
                },
              },
              realtime: { enabled: false },
              storage: { enabled: false },
              functions: { enabled: false },
              studio: { enabled: false },
              mail: { enabled: false },
              analytics: { enabled: false },
              pooler: { enabled: false },
            },
            listeners: {
              database: { enabled: false },
              pooler: { enabled: false },
              studio: { enabled: false },
              mailUi: { enabled: false },
              smtp: { enabled: false },
              pop3: { enabled: false },
              functionsInspector: { enabled: false },
            },
          },
        });
        const store = yield* makeStackStateStore({ stateRoot: root });
        const persisted: PersistedStackState = {
          format: "supabase-stack-state-v1" as const,
          identity: { ...stackIdentity, stackId },
          runtime: { kind: "native" as const },
          desiredLifecycle: "running" as const,
          definition: compiled.definition,
          inputFingerprint: compiled.inputFingerprint,
          ports: [{ field: "api", port: 55435, intent: "automatic" }] as const,
          privatePorts: privateBindingIntentsFor(compiled.executionPlan).map((binding, index) => ({
            ...binding,
            port: 30300 + index,
          })),
          secrets: {},
        };
        yield* store.initialize(stackId, persisted);
        const registry = yield* makePortRegistry({ stateRoot: root, store });
        const activated: string[] = [];
        const ingress = yield* makeSupervisorIngress({
          stackId,
          registry,
          store,
          context,
          apiMaterial: () =>
            Effect.succeed({
              publishableKey: "sb_publishable_test",
              secretKey: "sb_secret_test",
              anonJwt: "anon-jwt",
              serviceRoleJwt: "service-jwt",
            }),
          resolveAuthTemplates: () =>
            Effect.all({ root: fs.realPath(root), template: fs.realPath(templatePath) }).pipe(
              Effect.mapError(
                (cause) => new StackPreparationError({ message: "Template is unavailable", cause }),
              ),
              Effect.flatMap(({ root: canonicalRoot, template: canonicalPath }) =>
                !path.relative(canonicalRoot, canonicalPath).startsWith("..") &&
                !path.isAbsolute(path.relative(canonicalRoot, canonicalPath))
                  ? Effect.succeed([
                      {
                        id: "confirmation",
                        extension: ".html",
                        canonicalPath,
                      },
                    ])
                  : Effect.fail(new StackPreparationError({ message: "Template escaped root" })),
              ),
            ),
        });
        const input = {
          stackId,
          desiredLifecycle: "running" as const,
          state: persisted,
          definition: compiled.definition,
          inputFingerprint: compiled.inputFingerprint,
          secrets: {},
          plan: compiled.executionPlan,
        };
        const reservation = yield* ingress.acquire(input);
        yield* ingress.open(input, reservation, (capability) => {
          activated.push(capability);
          return Effect.fail(new GatewayActivationError({ message: "not reached" }));
        });
        const api = reservation.assignments.api;
        if (api === undefined) return yield* Effect.die("API listener was not assigned");
        const first = yield* request(api.port, "/email/confirmation.html");
        expect(first.status).toBe(200);
        expect(first.body).toBe("first");
        expect(activated).toEqual([]);
        yield* fs.writeFileString(templatePath, "second");
        const second = yield* request(api.port, "/email/confirmation.html?live=1");
        expect(second.status).toBe(200);
        expect(second.body).toBe("second");
        expect((yield* request(api.port, "/email/unknown.html")).status).toBe(404);
        expect((yield* request(api.port, "/email/confirmation.html", "POST")).status).toBe(404);
        expect((yield* request(api.port, "/email/confirmation.html", "OPTIONS")).status).toBe(404);
        expect((yield* request(api.port, "/email/../outside.html")).status).toBe(404);
        expect((yield* request(api.port, "/email/%2e%2e/outside.html")).status).toBe(404);
        yield* fs.remove(templatePath);
        expect((yield* request(api.port, "/email/confirmation.html")).status).toBe(404);
        yield* fs.writeFileString(outsidePath, "outside");
        yield* fs.symlink(outsidePath, templatePath);
        expect((yield* request(api.port, "/email/confirmation.html")).status).toBe(404);
        expect(activated).toEqual([]);
        yield* ingress.close;
      }),
    ),
  );
});
