// oxlint-disable effecttsgo/node-builtin-import -- Upgrade tests exercise native supervisor process services.
import { NodeServices } from "@effect/platform-node";
import { it } from "@effect/vitest";
import { Cause, Effect, Exit, Fiber, Option } from "effect";
import * as TestClock from "effect/testing/TestClock";
import { afterEach, describe, expect } from "vitest";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ControlTransportError,
  type ControlSupervisorStatus,
  type ControlTransportShape,
} from "./managed/control.ts";
import type { ManagedStack, ManagedStackManagerShape } from "./managed/manager.ts";
import type { SupervisorStartMessage } from "./SupervisorProtocol.ts";
import { SERVICE_CATALOG, SERVICE_NAMES } from "./ServiceCatalog.ts";
import type { ServiceName } from "./ServiceName.ts";
import { reservePortSet } from "./PortAllocator.ts";
import { prepareUpgradeReplacement } from "./SupervisorUpgradeRestart.ts";
import { StopTimeout, UpgradePreflightError, UpgradeRestartError } from "./errors.ts";
import type { DaemonConfigInput } from "./StackConfigResolver.ts";
import { fillServiceVersionManifest } from "./versions.ts";

const roots: Array<string> = [];

const allPersistedVersions = fillServiceVersionManifest({});

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const setup = (persistedVersions: Partial<Record<ServiceName, string>> = { auth: "v-old" }) => {
  const root = mkdtempSync(join(tmpdir(), "supervisor-upgrade-restart-"));
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
  const status: ControlSupervisorStatus = {
    controlProtocol: "supabase-stack-control",
    controlProtocolVersion: 1,
    ownershipId: stackId,
    ownerSessionId: "old-session",
    kind: "supervisor",
    state: "running",
    ready: true,
    daemonCliVersion: "old",
  };
  const oldOwner = {
    endpoint,
    status,
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
      versions: persistedVersions,
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
    listStacks: Effect.die("unused manager operation"),
    allocateManagedPorts: unused,
    validateManagedPortReservations: () => Effect.void,
    recordLifecycle: unused,
    updateLaunch: unused,
    repairWorkspace: unused,
    deleteStack: unused,
  };
  const stopState = { requested: false };
  const stopRequest = { intent: undefined as "explicit" | "replacement" | undefined };
  const transport: ControlTransportShape = {
    bind: () => Effect.die("unused bind"),
    read: (readEndpoint) =>
      stopState.requested
        ? Effect.fail(
            new ControlTransportError({
              endpoint: readEndpoint,
              reason: "unreachable",
              cause: new Error("old owner ended"),
            }),
          )
        : Effect.succeed(status),
    requestStop: (_endpoint, request) =>
      Effect.sync(() => {
        stopState.requested = true;
        stopRequest.intent = request.intent;
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
    cliVersion: "new",
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
  return {
    configInput,
    endpoint,
    input,
    manager,
    oldCliVersion: "old",
    oldOwner,
    stackId,
    stopState,
    stopRequest,
    transport,
  };
};

describe("incompatible supervisor upgrade restart", () => {
  it.effect("bounds preflight before stopping the old owner", () => {
    const context = setup();
    return Effect.gen(function* () {
      const pending = yield* prepareUpgradeReplacement({
        ...context,
        configInput: context.configInput,
        manager: { ...context.manager, inspectStack: () => Effect.never },
        controlTransport: context.transport,
        resolutionTimeout: "30 seconds",
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
            detail: "Timed out preflighting upgrade restart",
          });
        }
      }
    });
  });

  it.live("uses the persisted launch instead of the restart invocation", () => {
    const context = setup();
    return prepareUpgradeReplacement({
      ...context,
      configInput: context.configInput,
      controlTransport: context.transport,
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

  it.live("fences upgrade replacement with replacement stop intent", () => {
    const context = setup();
    return prepareUpgradeReplacement({
      ...context,
      configInput: context.configInput,
      controlTransport: context.transport,
    }).pipe(
      Effect.provide(NodeServices.layer),
      Effect.scoped,
      Effect.tap(() =>
        Effect.sync(() => {
          expect(context.stopRequest.intent).toBe("replacement");
        }),
      ),
      Effect.asVoid,
    );
  });

  it.live("refreshes a launch update committed during the initial preflight", () => {
    const context = setup();
    let inspections = 0;
    return Effect.gen(function* () {
      const initial = yield* context.manager.inspectStack(context.stackId);
      if (initial === undefined) return yield* Effect.die("expected managed stack document");
      const refreshed: ManagedStack = {
        ...initial,
        launch: {
          ...initial.launch,
          versions: { ...initial.launch.versions, auth: "v-refreshed" },
        },
      };
      const result = yield* prepareUpgradeReplacement({
        ...context,
        manager: {
          ...context.manager,
          inspectStack: () => Effect.sync(() => (inspections++ === 0 ? initial : refreshed)),
        },
        controlTransport: context.transport,
      });
      expect(result.effectiveConfigInput.auth).toEqual({ version: "v-refreshed" });
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped);
  });

  it.live("reports a restart failure when the refreshed launch cannot be preflighted", () => {
    const context = setup();
    let inspections = 0;
    return Effect.gen(function* () {
      const exit = yield* prepareUpgradeReplacement({
        ...context,
        manager: {
          ...context.manager,
          inspectStack: () =>
            inspections++ === 0
              ? context.manager.inspectStack(context.stackId)
              : Effect.void.pipe(Effect.as(undefined)),
        },
        controlTransport: context.transport,
      }).pipe(Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const error = Cause.findErrorOption(exit.cause);
        expect(Option.isSome(error)).toBe(true);
        if (Option.isSome(error)) {
          expect(error.value).toBeInstanceOf(UpgradeRestartError);
          expect(error.value).toMatchObject({
            stackId: context.stackId,
            newCliVersion: context.input.cliVersion,
            detail: "Managed stack document is missing",
          });
        }
      }
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped);
  });

  it.live("pins enabled services to persisted launch versions", () => {
    const context = setup();
    const configInput = { ...context.configInput, auth: { version: "v-new" } };
    const launch = context.input.launch ?? { versions: {} };
    const input = {
      ...context.input,
      launch: { ...launch, excludedServices: [] },
    };
    return prepareUpgradeReplacement({
      ...context,
      input,
      configInput,
      controlTransport: context.transport,
    }).pipe(
      Effect.provide(NodeServices.layer),
      Effect.scoped,
      Effect.tap((result) =>
        Effect.sync(() => {
          expect(result.effectiveConfigInput.auth).toEqual({ version: "v-old" });
        }),
      ),
      Effect.asVoid,
    );
  });

  it.live("persists a concrete version for an enabled service introduced after the old CLI", () => {
    const context = setup({ postgres: "pg-old" });
    const configInput = { ...context.configInput, auth: { version: "auth-current" } };
    return prepareUpgradeReplacement({
      ...context,
      configInput,
      controlTransport: context.transport,
    }).pipe(
      Effect.provide(NodeServices.layer),
      Effect.scoped,
      Effect.tap((result) =>
        Effect.sync(() => {
          expect(result.launch.versions).toMatchObject({
            auth: "auth-current",
            postgres: "pg-old",
          });
        }),
      ),
      Effect.asVoid,
    );
  });

  it.live(
    "rejects an occupied exact port for a newly activated sticky service before stopping",
    () => {
      const context = setup();
      return Effect.scoped(
        Effect.gen(function* () {
          const blocker = yield* reservePortSet([
            { field: "studioPort", selection: { kind: "automatic" } },
          ]);
          yield* Effect.addFinalizer(() => blocker.releaseAll);
          const occupiedPort = blocker.ports.studioPort;
          if (occupiedPort === undefined) return yield* Effect.die("expected an occupied port");

          const exit = yield* prepareUpgradeReplacement({
            ...context,
            configInput: {
              ...context.configInput,
              edgeRuntime: { inspectorPort: occupiedPort, version: "edge-current" },
            },
            controlTransport: context.transport,
          }).pipe(Effect.exit);

          expect(Exit.isFailure(exit)).toBe(true);
          if (Exit.isFailure(exit)) {
            const error = Cause.findErrorOption(exit.cause);
            expect(Option.isSome(error)).toBe(true);
            if (Option.isSome(error)) expect(error.value).toBeInstanceOf(UpgradePreflightError);
          }
          expect(context.stopState.requested).toBe(false);
        }),
      ).pipe(Effect.provide(NodeServices.layer));
    },
  );

  it.live("keeps restart-request exclusions from enabling native Docker-only services", () => {
    const context = setup(allPersistedVersions);
    const launch = context.input.launch ?? { versions: {} };
    const input = {
      ...context.input,
      launch: { ...launch, excludedServices: ["studio", "analytics"] },
    };
    return prepareUpgradeReplacement({
      ...context,
      input,
      configInput: context.configInput,
      controlTransport: context.transport,
    }).pipe(
      Effect.provide(NodeServices.layer),
      Effect.scoped,
      Effect.tap((result) =>
        Effect.sync(() => {
          for (const service of SERVICE_NAMES) {
            if (SERVICE_CATALOG[service].runtimeSupport === "docker-only") {
              const configKey = SERVICE_CATALOG[service].configKey;
              expect(result.effectiveConfigInput[configKey]).toEqual(
                context.configInput[configKey],
              );
            }
          }
        }),
      ),
      Effect.asVoid,
    );
  });

  it.effect("reports the refreshed owner state when stop times out", () => {
    const context = setup();
    const stoppingStatus: ControlSupervisorStatus = {
      ...context.oldOwner.status,
      state: "stopping",
      ready: false,
    };
    const transport: ControlTransportShape = {
      ...context.transport,
      read: () => Effect.succeed(stoppingStatus),
      requestStop: () => Effect.never,
    };
    return Effect.gen(function* () {
      const pending = yield* prepareUpgradeReplacement({
        ...context,
        controlTransport: transport,
        resolutionTimeout: "30 seconds",
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
          expect(error.value).toBeInstanceOf(StopTimeout);
          expect(error.value).toMatchObject({ lastState: "stopping" });
        }
      }
    });
  });
});
