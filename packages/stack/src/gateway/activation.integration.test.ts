import { NodeServices } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import { Deferred, Effect, Exit, Fiber, FileSystem, Redacted, Schema, Scope } from "effect";
import * as TestClock from "effect/testing/TestClock";
import { connect as connectNet, type Socket } from "node:net";
import { StackIdSchema } from "../public/StackId.ts";
import type { CapabilityName } from "../public/Capability.ts";
import { GatewayActivationError } from "../public/Errors.ts";
import {
  ACTIVATION_FILE_FORMAT,
  generateActivationCapability,
  readActivationFile,
  writeActivationFile,
  type ActivationFile,
} from "./ActivationFile.ts";
import { createLazyActivator, type ActivationTarget } from "./Gateway.ts";
import {
  ACTIVATION_MAX_FRAME_BYTES,
  ACTIVATION_MAX_CONCURRENT_REQUESTS,
  requestActivation,
  startActivationServer,
} from "./ActivationServer.ts";

const withPlatform = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.scoped(effect).pipe(Effect.provide(NodeServices.layer));

const wireFrame = (text: string): Uint8Array => {
  const body = new TextEncoder().encode(text);
  const frame = new Uint8Array(body.byteLength + 4);
  new DataView(frame.buffer).setUint32(0, body.byteLength, false);
  frame.set(body, 4);
  return frame;
};

const rawActivationExchange = (
  port: number,
  payload: Uint8Array,
): Effect.Effect<Uint8Array, Error> =>
  Effect.callback<Uint8Array, Error>((resume) => {
    const socket = connectNet(port, "127.0.0.1");
    const chunks: Buffer[] = [];
    const onError = (error: Error) => resume(Effect.fail(error));
    socket.once("error", onError);
    socket.on("data", (chunk: Buffer) => chunks.push(chunk));
    socket.once("end", () => resume(Effect.succeed(Buffer.concat(chunks))));
    socket.once("connect", () => socket.write(payload));
    return Effect.sync(() => socket.destroy());
  });

describe("gateway activation", () => {
  it.live("writes and reads an owner-only exact activation file", () =>
    withPlatform(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "stack-activation-" });
        const stackId = yield* Schema.decodeEffect(StackIdSchema)("a".repeat(64));
        const value: ActivationFile = {
          format: ACTIVATION_FILE_FORMAT,
          endpoint: { host: "127.0.0.1", port: 44551 },
          capability: Redacted.make("test-capability"),
          stackId,
          desiredGeneration: 3,
          gatewayInstanceId: "gateway-1",
          ownerSessionId: "owner-1",
        };
        yield* writeActivationFile(`${root}/activation.json`, value);
        expect((yield* fs.stat(`${root}/activation.json`)).mode & 0o777).toBe(0o600);
        expect(yield* readActivationFile(`${root}/activation.json`)).toEqual(value);
      }),
    ),
  );

  it.live("generates a high-entropy redacted activation capability", () =>
    withPlatform(
      Effect.gen(function* () {
        const capability = yield* generateActivationCapability;
        expect(Redacted.value(capability)).toHaveLength(64);
        // oxlint-disable-next-line typescript/no-base-to-string
        expect(String(capability)).not.toContain(Redacted.value(capability));
      }),
    ),
  );

  it.live("does not let an old owner scope remove a rotated activation file", () =>
    withPlatform(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "stack-activation-rotate-" });
        const path = `${root}/activation.json`;
        const stackId = yield* Schema.decodeEffect(StackIdSchema)("c".repeat(64));
        const parent = yield* Scope.Scope;
        const oldScope = yield* Scope.fork(parent, "sequential");
        const first: ActivationFile = {
          format: ACTIVATION_FILE_FORMAT,
          endpoint: { host: "127.0.0.1", port: 44551 },
          capability: Redacted.make("old-capability"),
          stackId,
          desiredGeneration: 1,
          gatewayInstanceId: "gateway-old",
          ownerSessionId: "owner-old",
        };
        yield* writeActivationFile(path, first).pipe(Effect.provideService(Scope.Scope, oldScope));
        const second = {
          ...first,
          capability: Redacted.make("new-capability"),
          gatewayInstanceId: "gateway-new",
        };
        yield* writeActivationFile(path, second);
        yield* Scope.close(oldScope, Exit.void);
        expect(yield* readActivationFile(path)).toEqual(second);
      }),
    ),
  );

  it.live("removes a temporary activation file when publication fails", () =>
    withPlatform(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "stack-activation-failed-" });
        const path = `${root}/occupied`;
        yield* fs.makeDirectory(path);
        const stackId = yield* Schema.decodeEffect(StackIdSchema)("a".repeat(64));
        const value: ActivationFile = {
          format: ACTIVATION_FILE_FORMAT,
          endpoint: { host: "127.0.0.1", port: 44551 },
          capability: Redacted.make("failed-publication"),
          stackId,
          desiredGeneration: 0,
          gatewayInstanceId: "gateway-failed",
          ownerSessionId: "owner-failed",
        };
        const result = yield* writeActivationFile(path, value).pipe(Effect.exit);
        expect(Exit.isFailure(result)).toBe(true);
        const entries = yield* fs.readDirectory(root);
        expect(entries.filter((entry) => entry.startsWith("occupied.")).length).toBe(0);
      }),
    ),
  );

  it.live("activates a dependency closure once and retains it for the generation", () =>
    Effect.gen(function* () {
      const started: string[] = [];
      const targets: Readonly<Partial<Record<CapabilityName, ActivationTarget>>> = {
        rest: { dependencies: ["database"] },
        database: { dependencies: [] },
      };
      const activator = yield* createLazyActivator({
        generation: 8,
        targets,
        activate: (target) =>
          Effect.sync(() => {
            started.push(target);
            return { capability: target, endpoint: { host: "127.0.0.1", port: 54321 } };
          }),
      });
      yield* Effect.all([activator.activate("rest"), activator.activate("rest")], {
        concurrency: "unbounded",
      });
      expect(started).toEqual(["database", "rest"]);
    }),
  );

  it.live("retries a failed activation while retaining successful activations", () =>
    Effect.gen(function* () {
      let attempts = 0;
      const activator = yield* createLazyActivator({
        generation: 8,
        targets: { rest: { dependencies: [] } },
        activate: (target) =>
          Effect.suspend(() => {
            attempts += 1;
            return attempts === 1
              ? Effect.fail(new GatewayActivationError({ message: "transient" }))
              : Effect.succeed({
                  capability: target,
                  endpoint: { host: "127.0.0.1", port: 54321 },
                });
          }),
      });
      const first = yield* activator.activate("rest").pipe(Effect.exit);
      expect(Exit.isFailure(first)).toBe(true);
      const second = yield* activator.activate("rest");
      expect(second.capability).toBe("rest");
      expect(attempts).toBe(2);
    }),
  );

  it.live("keeps a shared activation alive when the first waiter is interrupted", () =>
    Effect.gen(function* () {
      const started = Deferred.makeUnsafe<void>();
      const release = Deferred.makeUnsafe<void>();
      let attempts = 0;
      const activator = yield* createLazyActivator({
        generation: 9,
        targets: { rest: { dependencies: [] } },
        activate: (target) =>
          Effect.gen(function* () {
            attempts += 1;
            yield* Deferred.succeed(started, undefined);
            yield* Deferred.await(release);
            return { capability: target, endpoint: { host: "127.0.0.1", port: 54321 } };
          }),
      });
      const first = yield* Effect.forkChild(activator.activate("rest"));
      yield* Deferred.await(started);
      yield* Fiber.interrupt(first);
      const second = yield* Effect.forkChild(activator.activate("rest"));
      yield* Deferred.succeed(release, undefined);
      const result = yield* Fiber.join(second);
      expect(result.capability).toBe("rest");
      expect(attempts).toBe(1);
    }),
  );

  it.live("interrupts a blocked activation when its owner scope closes", () =>
    Effect.gen(function* () {
      const parent = yield* Scope.Scope;
      const owner = yield* Scope.fork(parent, "sequential");
      let interrupted = false;
      const entered = Deferred.makeUnsafe<void>();
      const hold = Deferred.makeUnsafe<void>();
      const activator = yield* createLazyActivator({
        generation: 10,
        targets: { rest: { dependencies: [] } },
        activate: () =>
          Deferred.succeed(entered, undefined).pipe(
            Effect.andThen(Deferred.await(hold)),
            Effect.onInterrupt(() => Effect.sync(() => (interrupted = true))),
            Effect.as({ capability: "rest", endpoint: { host: "127.0.0.1", port: 54321 } }),
          ),
      }).pipe(Effect.provideService(Scope.Scope, owner));
      const request = yield* Effect.forkChild(activator.activate("rest"));
      yield* Deferred.await(entered);
      yield* Scope.close(owner, Exit.void);
      yield* Fiber.join(request).pipe(Effect.exit);
      expect(interrupted).toBe(true);
    }),
  );

  it.live("rejects activation for a missing target", () =>
    Effect.gen(function* () {
      const activator = yield* createLazyActivator({
        generation: 1,
        targets: {},
        activate: (target) =>
          Effect.succeed({ capability: target, endpoint: { host: "127.0.0.1", port: 1 } }),
      });
      const exit = yield* activator.activate("rest").pipe(Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
    }),
  );

  it.live("enforces activation capability and generation fences", () =>
    withPlatform(
      Effect.gen(function* () {
        const stackId = yield* Schema.decodeEffect(StackIdSchema)("b".repeat(64));
        const capability = Redacted.make("capability-secret");
        const gatewayInstanceId = Redacted.make("gateway-2");
        const ownerSessionId = Redacted.make("owner-2");
        const server = yield* startActivationServer({
          capability,
          stackId,
          desiredGeneration: 4,
          gatewayInstanceId,
          ownerSessionId,
          activate: (capability) =>
            Effect.succeed({ capability, endpoint: { host: "127.0.0.1", port: 54322 } }),
        });
        const validRequest = {
          protocol: "gateway-activation-v1" as const,
          operation: "activate" as const,
          capability,
          target: "database" as const,
          stackId,
          desiredGeneration: 4,
          gatewayInstanceId,
          ownerSessionId,
        };
        const response = yield* requestActivation({
          endpoint: server.endpoint,
          request: validRequest,
        });
        expect(response.capability).toBe("database");
        const fences = [
          { ...validRequest, capability: Redacted.make("wrong-capability") },
          { ...validRequest, gatewayInstanceId: Redacted.make("wrong-gateway") },
          { ...validRequest, ownerSessionId: Redacted.make("wrong-owner") },
          { ...validRequest, desiredGeneration: 3 },
        ];
        for (const fenced of fences) {
          const rejected = yield* requestActivation({
            endpoint: server.endpoint,
            request: fenced,
          }).pipe(Effect.exit);
          expect(Exit.isFailure(rejected)).toBe(true);
        }
      }),
    ),
  );

  it.live("rejects oversized and trailing activation frames", () =>
    withPlatform(
      Effect.gen(function* () {
        const stackId = yield* Schema.decodeEffect(StackIdSchema)("d".repeat(64));
        const capability = Redacted.make("frame-capability");
        const gatewayInstanceId = Redacted.make("frame-gateway");
        const ownerSessionId = Redacted.make("frame-owner");
        const server = yield* startActivationServer({
          capability,
          stackId,
          desiredGeneration: 1,
          gatewayInstanceId,
          ownerSessionId,
          activate: (target) =>
            Effect.succeed({ capability: target, endpoint: { host: "127.0.0.1", port: 54323 } }),
        });
        // oxlint-disable-next-line effecttsgo/prefer-schema-over-json
        const request = JSON.stringify({
          protocol: "gateway-activation-v1",
          operation: "activate",
          capability: "frame-capability",
          target: "database",
          stackId,
          desiredGeneration: 1,
          gatewayInstanceId: "frame-gateway",
          ownerSessionId: "frame-owner",
        });
        const trailing = yield* rawActivationExchange(
          server.endpoint.port,
          new Uint8Array([...wireFrame(request), ...wireFrame(request)]),
        );
        // oxlint-disable-next-line effecttsgo/prefer-schema-over-json
        expect(JSON.parse(new TextDecoder().decode(trailing.slice(4))).error.tag).toBe(
          "invalid-request",
        );
        const oversized = new Uint8Array(4);
        new DataView(oversized.buffer).setUint32(0, ACTIVATION_MAX_FRAME_BYTES + 1, false);
        const rejected = yield* rawActivationExchange(server.endpoint.port, oversized);
        // oxlint-disable-next-line effecttsgo/prefer-schema-over-json
        expect(JSON.parse(new TextDecoder().decode(rejected.slice(4))).error.tag).toBe(
          "invalid-request",
        );
      }),
    ),
  );

  it.live("interrupts blocked activation at the server deadline", () =>
    withPlatform(
      Effect.gen(function* () {
        const stackId = yield* Schema.decodeEffect(StackIdSchema)("e".repeat(64));
        const capability = Redacted.make("deadline-capability");
        const gatewayInstanceId = Redacted.make("deadline-gateway");
        const ownerSessionId = Redacted.make("deadline-owner");
        let interrupted = false;
        const entered = Deferred.makeUnsafe<void>();
        const server = yield* startActivationServer({
          capability,
          stackId,
          desiredGeneration: 1,
          gatewayInstanceId,
          ownerSessionId,
          activate: () =>
            Deferred.succeed(entered, undefined).pipe(
              Effect.andThen(Effect.never),
              Effect.onInterrupt(() => Effect.sync(() => (interrupted = true))),
            ),
        });
        // oxlint-disable-next-line effecttsgo/prefer-schema-over-json
        const request = JSON.stringify({
          protocol: "gateway-activation-v1",
          operation: "activate",
          capability: "deadline-capability",
          target: "database",
          stackId,
          desiredGeneration: 1,
          gatewayInstanceId: "deadline-gateway",
          ownerSessionId: "deadline-owner",
        });
        const exchange = yield* Effect.forkChild(
          rawActivationExchange(server.endpoint.port, wireFrame(request)),
        );
        yield* Deferred.await(entered);
        yield* TestClock.adjust("5 seconds");
        const response = yield* Fiber.join(exchange);
        // oxlint-disable-next-line effecttsgo/prefer-schema-over-json
        expect(JSON.parse(new TextDecoder().decode(response.slice(4))).error.tag).toBe(
          "activation",
        );
        expect(interrupted).toBe(true);
      }),
    ).pipe(Effect.provide(TestClock.layer())),
  );

  it.live("bounds concurrent activation connections", () =>
    withPlatform(
      Effect.gen(function* () {
        const stackId = yield* Schema.decodeEffect(StackIdSchema)("f".repeat(64));
        const capability = Redacted.make("bound-capability");
        const gatewayInstanceId = Redacted.make("bound-gateway");
        const ownerSessionId = Redacted.make("bound-owner");
        const entered = Deferred.makeUnsafe<void>();
        const release = Deferred.makeUnsafe<void>();
        let active = 0;
        const server = yield* startActivationServer({
          capability,
          stackId,
          desiredGeneration: 1,
          gatewayInstanceId,
          ownerSessionId,
          activate: () =>
            Effect.gen(function* () {
              active += 1;
              if (active === ACTIVATION_MAX_CONCURRENT_REQUESTS)
                yield* Deferred.succeed(entered, undefined);
              yield* Deferred.await(release);
              active -= 1;
              return { capability: "database", endpoint: { host: "127.0.0.1", port: 54324 } };
            }),
        });
        // oxlint-disable-next-line effecttsgo/prefer-schema-over-json
        const request = JSON.stringify({
          protocol: "gateway-activation-v1",
          operation: "activate",
          capability: "bound-capability",
          target: "database",
          stackId,
          desiredGeneration: 1,
          gatewayInstanceId: "bound-gateway",
          ownerSessionId: "bound-owner",
        });
        const open = (): Effect.Effect<Socket, Error> =>
          Effect.callback<Socket, Error>((resume) => {
            const socket = connectNet(server.endpoint.port, "127.0.0.1");
            let settled = false;
            const finish = () => {
              if (settled) return;
              settled = true;
              resume(Effect.succeed(socket));
            };
            socket.once("connect", () => socket.write(wireFrame(request)));
            socket.once("connect", finish);
            socket.once("close", finish);
            socket.once("error", finish);
            return Effect.sync(() => socket.destroy());
          });
        const clients = yield* Effect.forEach(
          Array.from({ length: 17 }, (_, index) => index),
          open,
          {
            concurrency: "unbounded",
          },
        );
        yield* Deferred.await(entered);
        expect(active).toBe(ACTIVATION_MAX_CONCURRENT_REQUESTS);
        yield* Deferred.succeed(release, undefined);
        for (const client of clients) client.destroy();
      }),
    ),
  );
});
