import { NodeServices } from "@effect/platform-node";
import { it } from "@effect/vitest";
import { Cause, Effect, Exit, Fiber, Option } from "effect";
import * as TestClock from "effect/testing/TestClock";
import { afterEach, describe, expect } from "vitest";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ControlBindError,
  ControlTransportError,
  type ControlAttached,
  type ControlOwnerStatus,
  type ControlTransportShape,
} from "./managed/control.ts";
import type { ManagedStack, ManagedStackManagerShape } from "./managed/manager.ts";
import type { SupervisorStartMessage } from "./SupervisorProtocol.ts";
import { replaceIncompatibleOwner } from "./SupervisorReplacement.ts";
import { UpgradePreflightError, UpgradeRestartError } from "./errors.ts";
import type { DaemonConfigInput } from "./StackConfigResolver.ts";

const roots: Array<string> = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const setup = () => {
  const root = mkdtempSync(join(tmpdir(), "supervisor-replacement-"));
  roots.push(root);
  const workspacePath = join(root, "workspace");
  const stateRoot = join(root, "state");
  mkdirSync(workspacePath);
  mkdirSync(stateRoot);
  const stackId = "a".repeat(64);
  const endpoint = {
    hostname: "127.0.0.1",
    port: 54321,
    url: "http://127.0.0.1:54321",
  } as const;
  const status: ControlOwnerStatus = {
    controlProtocol: "supabase-stack-control",
    controlProtocolVersion: 1,
    ownershipId: stackId,
    ownerSessionId: "old-session",
    state: "running",
    ready: true,
    daemonCliVersion: "old",
    daemonBuildId: "release:old",
  };
  const oldOwner: ControlAttached = {
    _tag: "Attached",
    ownershipId: stackId,
    endpoint,
    observedStatus: status,
    ownerStatus: Effect.succeed(status),
    requestStop: Effect.void,
  };
  const document: ManagedStack = {
    format: "supabase-stack",
    formatVersion: 1,
    id: stackId,
    identity: {
      workspaceId: "workspace",
      checkoutId: "checkout",
      contextId: "context",
      localProjectKey: ".",
      name: "default",
    },
    workspace: {
      kind: "folder",
      checkoutKind: "folder",
      path: workspacePath,
      branch: "main",
    },
    ports: [],
    lifecycle: "running",
    launch: {
      mode: "native",
      versions: { auth: "v-old" },
      excludedServices: [],
    },
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
  const unused = () => Effect.die("unused manager operation");
  const manager: ManagedStackManagerShape = {
    stateRoot,
    discoverWorkspace: unused,
    ensureWorkspace: unused,
    acquireControl: unused,
    probeControl: unused,
    readStack: unused,
    startStack: unused,
    inspectStack: () => Effect.succeed(document),
    listStacks: unused,
    allocateManagedPorts: unused,
    recordLifecycle: unused,
    updateLaunch: unused,
    repairWorkspace: unused,
    deleteStack: unused,
  };
  let stopped = false;
  const transport: ControlTransportShape = {
    bind: () => Effect.die("unused bind"),
    read: (readEndpoint) =>
      stopped
        ? Effect.fail(
            new ControlTransportError({
              endpoint: readEndpoint,
              reason: "unreachable",
              cause: new Error("old owner ended"),
            }),
          )
        : Effect.succeed(status),
    requestStop: () =>
      Effect.sync(() => {
        stopped = true;
      }),
  };
  const configInput: DaemonConfigInput = {
    cwd: workspacePath,
    projectDir: workspacePath,
    mode: "native",
    auth: false,
    postgrest: false,
    realtime: false,
    storage: false,
    imgproxy: false,
    mailpit: false,
    pgmeta: false,
    studio: false,
    analytics: false,
    vector: false,
    pooler: false,
  };
  const input: SupervisorStartMessage = {
    type: "start",
    buildIdentity: { cliVersion: "new", buildId: "release:new" },
    incompatibleOwnerPolicy: "replace",
    stackId,
    workspacePath,
    stackName: "default",
    stateRoot,
    config: configInput,
    portIntents: { activeFields: ["apiPort", "dbPort"], document: {} },
    launch: {
      mode: "native",
      versions: { auth: "v-new" },
      excludedServices: ["auth"],
    },
  };
  return { configInput, endpoint, input, manager, oldOwner, stackId, transport };
};

describe("incompatible supervisor replacement", () => {
  it.effect("bounds preflight before stopping the old owner", () => {
    const context = setup();
    return Effect.gen(function* () {
      const pending = yield* replaceIncompatibleOwner({
        ...context,
        oldOwner: context.oldOwner,
        configInput: context.configInput,
        manager: { ...context.manager, inspectStack: () => Effect.never },
        controlTransport: context.transport,
        resolutionTimeout: "30 seconds",
        authorize: () => Effect.void,
        reacquire: () => Effect.succeed(context.oldOwner),
      }).pipe(
        Effect.provide(NodeServices.layer),
        Effect.scoped,
        Effect.exit,
        Effect.forkChild({ startImmediately: true }),
      );
      yield* Effect.yieldNow;
      yield* TestClock.adjust("30 seconds");
      yield* Effect.yieldNow;
      const exit = yield* Fiber.join(pending);
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const error = Cause.findErrorOption(exit.cause);
        expect(Option.isSome(error)).toBe(true);
        if (Option.isSome(error)) {
          expect(error.value).toBeInstanceOf(UpgradePreflightError);
          expect(error.value).toMatchObject({
            detail: "Timed out preflighting incompatible daemon replacement",
          });
        }
      }
    });
  });

  it.live("uses the persisted launch instead of the replacing invocation", () => {
    const context = setup();
    return replaceIncompatibleOwner({
      ...context,
      oldOwner: context.oldOwner,
      configInput: context.configInput,
      controlTransport: context.transport,
      authorize: () => Effect.void,
      reacquire: () => Effect.succeed(context.oldOwner),
    }).pipe(
      Effect.provide(NodeServices.layer),
      Effect.scoped,
      Effect.tap((result) =>
        Effect.sync(() => {
          expect(result.effectiveConfigInput.auth).toEqual({ version: "v-old" });
          expect(result.effectiveConfigInput.servicePolicies?.auth).not.toBe("off");
        }),
      ),
      Effect.asVoid,
    );
  });

  it.live("reports an upgrade restart failure after the old session ends", () => {
    const context = setup();
    return Effect.gen(function* () {
      const exit = yield* replaceIncompatibleOwner({
        ...context,
        oldOwner: context.oldOwner,
        configInput: context.configInput,
        controlTransport: context.transport,
        authorize: () => Effect.void,
        reacquire: () =>
          Effect.fail(
            new ControlBindError({
              endpoint: context.endpoint,
              reason: "failed",
              cause: new Error("replacement endpoint unavailable"),
            }),
          ),
      }).pipe(Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const error = Cause.findErrorOption(exit.cause);
        expect(Option.isSome(error)).toBe(true);
        if (Option.isSome(error)) {
          expect(error.value).toBeInstanceOf(UpgradeRestartError);
          expect(error.value).toMatchObject({
            stackId: context.stackId,
            newBuildId: context.input.buildIdentity.buildId,
            detail: "replacement endpoint unavailable",
          });
        }
      }
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped);
  });
});
