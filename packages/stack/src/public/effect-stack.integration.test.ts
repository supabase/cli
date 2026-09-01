import { NodeServices } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import {
  Cause,
  Deferred,
  Effect,
  Exit,
  FileSystem,
  Fiber,
  Option,
  Path,
  Redacted,
  Scope,
  Stream,
} from "effect";
import { startControlServer } from "../control/ControlServer.ts";
import { STACK_RPC_RELEASE, type StackRpcHandlers } from "../control/StackRpc.ts";
import { StackDestructionError, StackUpgradeRequiredError } from "./Errors.ts";
import { makeHandle } from "./EffectStack.ts";
import * as effectApi from "../effect.ts";
import { CAPABILITY_NAMES } from "./Capability.ts";
import { StackIdSchema } from "./StackId.ts";
import type { StackStatus } from "./Status.ts";

const stackId = StackIdSchema.make(
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
);

const runningStatus: StackStatus = {
  id: stackId,
  lifecycle: "running",
  desiredLifecycle: "running",
  runtime: { kind: "native" },
  endpoints: {},
  versions: {},
  capabilities: CAPABILITY_NAMES.map((name) => ({
    name,
    activation: name === "functions" ? "lazy" : "eager",
    state: name === "pooler" ? "disabled" : "ready",
  })),
};

const credentials = {
  database: { url: Redacted.make("postgres://localhost"), password: Redacted.make("secret") },
  api: {
    publishableKey: "publishable",
    secretKey: Redacted.make("secret"),
    anonJwt: "anon",
    serviceRoleJwt: Redacted.make("service"),
  },
};

describe("Effect stack lifecycle handoff", () => {
  it("does not publish the internal handle through the Effect barrel", () => {
    expect(Object.hasOwn(effectApi, "makeHandle")).toBe(false);
  });

  it.live("completes destroy after the owner closes its control socket", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "supabase-effect-stack-" });
        const endpoint = { kind: "unix" as const, path: path.join(root, "control.sock") };
        const ownerSessionId = "session";
        const responseSent = yield* Deferred.make<void>();
        const ownerScope = yield* Scope.make();
        const rpcHandlers: StackRpcHandlers = {
          status: () => Effect.succeed(runningStatus),
          credentials: () => Effect.succeed(credentials),
          prepare: () => Effect.succeed({ capabilities: [] }),
          start: () => Effect.succeed(runningStatus),
          restart: () => Effect.succeed(runningStatus),
          destroy: () => Effect.void,
          logs: () => Stream.empty,
          watchStatus: () => Stream.concat(Stream.make(runningStatus), Stream.never),
        };
        const maintenanceHandlers = {
          probe: Effect.succeed({
            ok: true,
            op: "probe",
            stackId,
            ownerSessionId,
            rpcRelease: STACK_RPC_RELEASE,
          } as const),
          stop: Effect.succeed({ ok: true, op: "stop" } as const),
          quiesce: Effect.succeed({ ok: true, op: "quiesce" } as const),
        };
        yield* startControlServer({
          endpoint,
          stackId,
          ownerSessionId,
          rpcHandlers,
          maintenanceHandlers,
          onDestroyResponse: () => Deferred.succeed(responseSent, undefined).pipe(Effect.asVoid),
        }).pipe(Effect.provideService(Scope.Scope, ownerScope));
        const stack = yield* makeHandle(stackId, {
          endpoint,
          ownerSessionId,
          rpcRelease: STACK_RPC_RELEASE,
        });
        const destroyFiber = yield* Effect.forkChild(stack.destroy(), { startImmediately: true });
        yield* Deferred.await(responseSent);
        yield* Scope.close(ownerScope, Exit.void);
        const destroyed = yield* Fiber.join(destroyFiber).pipe(Effect.exit);
        expect(Exit.isSuccess(destroyed)).toBe(true);
        yield* stack.close();
      }).pipe(Effect.provide(NodeServices.layer)),
    ),
  );

  it.live("fails destroy when the owner control endpoint is unavailable", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "supabase-effect-stack-" });
        const stack = yield* makeHandle(stackId, {
          endpoint: { kind: "unix", path: path.join(root, "missing.sock") },
          ownerSessionId: "session",
          rpcRelease: STACK_RPC_RELEASE,
        });
        const result = yield* stack.destroy().pipe(Effect.exit);
        expect(Exit.isFailure(result)).toBe(true);
        if (Exit.isFailure(result)) {
          const error = Cause.findErrorOption(result.cause);
          expect(Option.isSome(error)).toBe(true);
          if (Option.isSome(error)) {
            expect(error.value).toBeInstanceOf(StackDestructionError);
            expect(error.value.message).toContain("control connection");
          }
        }
        yield* stack.close();
      }).pipe(Effect.provide(NodeServices.layer)),
    ),
  );

  it.live("surfaces an incompatible RPC release from an existing handle", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "supabase-effect-stack-" });
        const endpoint = { kind: "unix" as const, path: path.join(root, "control.sock") };
        const ownerSessionId = "session";
        const rpcHandlers: StackRpcHandlers = {
          status: () => Effect.succeed(runningStatus),
          credentials: () => Effect.succeed(credentials),
          prepare: () => Effect.succeed({ capabilities: [] }),
          start: () => Effect.succeed(runningStatus),
          restart: () => Effect.succeed(runningStatus),
          destroy: () => Effect.void,
          logs: () => Stream.empty,
          watchStatus: () => Stream.empty,
        };
        yield* startControlServer({
          endpoint,
          stackId,
          ownerSessionId,
          rpcRelease: "stack-rpc-v0@0.0.1",
          rpcHandlers,
          maintenanceHandlers: {
            probe: Effect.succeed({
              ok: true,
              op: "probe",
              stackId,
              ownerSessionId,
              rpcRelease: "stack-rpc-v0@0.0.1",
            } as const),
            stop: Effect.succeed({ ok: true, op: "stop" } as const),
            quiesce: Effect.succeed({ ok: true, op: "quiesce" } as const),
          },
        });
        const stack = yield* makeHandle(stackId, {
          endpoint,
          ownerSessionId,
          rpcRelease: STACK_RPC_RELEASE,
        });
        const result = yield* stack.status().pipe(Effect.exit);
        expect(Exit.isFailure(result)).toBe(true);
        if (Exit.isFailure(result)) {
          const error = Cause.findErrorOption(result.cause);
          expect(Option.isSome(error)).toBe(true);
          if (Option.isSome(error)) {
            expect(error.value).toBeInstanceOf(StackUpgradeRequiredError);
            expect(error.value.message).toContain("stack-rpc-v0@0.0.1");
          }
        }
        const streamResult = yield* stack.watchStatus().pipe(Stream.runHead, Effect.exit);
        expect(Exit.isFailure(streamResult)).toBe(true);
        if (Exit.isFailure(streamResult)) {
          const error = Cause.findErrorOption(streamResult.cause);
          expect(Option.isSome(error)).toBe(true);
          if (Option.isSome(error)) {
            expect(error.value).toBeInstanceOf(StackUpgradeRequiredError);
            expect(error.value.message).toContain("stack-rpc-v0@0.0.1");
          }
        }
        yield* stack.close();
      }).pipe(Effect.provide(NodeServices.layer)),
    ),
  );
});
