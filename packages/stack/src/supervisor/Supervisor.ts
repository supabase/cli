import { Context, Crypto, Effect, FileSystem, Path, Schema, Stream } from "effect";
import type { StackIdentity } from "../identity/Identity.ts";
import type { PersistedStackState } from "../state/StackState.ts";
import type { StackStateStore } from "../state/StackStateStore.ts";
import {
  CAPABILITY_NAMES,
  type CapabilityName,
  type CapabilityStatus,
} from "../public/Capability.ts";
import type { StackEndpoint, StackStatus } from "../public/Status.ts";
import { StackIdSchema, type StackId } from "../public/StackId.ts";
import {
  StackStateFormatUnsupportedError,
  StackStateInvalidError,
  InvalidProjectRootError,
  type StackError,
} from "../public/Errors.ts";
import { StackRpcGroup, type StackRpcError, type StackRpcHandlers } from "../control/StackRpc.ts";
import type { MaintenanceResponse } from "../control/MaintenanceProtocol.ts";

export interface Supervisor {
  readonly identity: StackIdentity;
  readonly stackId: StackId;
  readonly ownerSessionId: string;
  readonly status: Effect.Effect<
    StackStatus,
    InvalidProjectRootError | StackStateInvalidError | StackStateFormatUnsupportedError
  >;
  readonly maintenanceHandlers: {
    readonly probe: Effect.Effect<MaintenanceResponse>;
    readonly stop: Effect.Effect<MaintenanceResponse>;
    readonly quiesce: Effect.Effect<MaintenanceResponse>;
  };
  readonly rpcHandlers: StackRpcHandlers;
}

export interface SupervisorOptions {
  readonly identity: StackIdentity;
  readonly stackId: StackId;
  readonly ownerSessionId: string;
  readonly rpcRelease: string;
  readonly stateStore: StackStateStore;
  readonly context: Context.Context<FileSystem.FileSystem | Path.Path | Crypto.Crypto>;
}

const capabilityState = (
  configured: { readonly enabled: boolean } | undefined,
): CapabilityStatus["state"] =>
  configured === undefined || !configured.enabled ? "disabled" : "stopped";

const statusFor = (
  state: PersistedStackState,
): Effect.Effect<StackStatus, StackStateInvalidError> => {
  const definition = state.definition;
  const capabilities = CAPABILITY_NAMES.map((name) => {
    const configured = definition?.capabilities[name];
    return {
      name,
      activation: configured?.activation ?? "eager",
      state: capabilityState(configured),
    };
  });
  const versions: Partial<Record<CapabilityName, string>> = {};
  if (definition !== undefined) {
    for (const name of CAPABILITY_NAMES) versions[name] = definition.capabilities[name].version;
  }
  const endpoints = state.ports.reduce<
    Readonly<
      Partial<
        Record<
          | "api"
          | "database"
          | "pooler"
          | "studio"
          | "mailUi"
          | "smtp"
          | "pop3"
          | "functionsInspector",
          StackEndpoint
        >
      >
    >
  >((result, assignment) => {
    const tcp =
      assignment.field === "database" ||
      assignment.field === "pooler" ||
      assignment.field === "smtp" ||
      assignment.field === "pop3";
    const protocol = tcp ? "tcp" : "http";
    const listener = state.definition?.listeners[assignment.field];
    return {
      ...result,
      [assignment.field]: {
        protocol,
        address: listener?.address ?? "127.0.0.1",
        port: assignment.port,
        url: `${protocol}://${listener?.address ?? "127.0.0.1"}:${assignment.port}`,
      },
    };
  }, {});
  return Schema.decodeEffect(StackIdSchema)(state.identity.stackId).pipe(
    Effect.mapError(
      (error) =>
        new StackStateInvalidError({ message: `Invalid persisted StackId: ${String(error)}` }),
    ),
    Effect.map((id) => ({
      id,
      lifecycle:
        state.desiredLifecycle === "unconfigured"
          ? "unconfigured"
          : state.desiredLifecycle === "destroying"
            ? "destroying"
            : "stopped",
      desiredLifecycle: state.desiredLifecycle,
      runtime: state.runtime,
      desiredGeneration: state.desiredGeneration,
      endpoints,
      versions,
      capabilities,
    })),
  );
};

const rpcError = (tag: StackRpcError["tag"], message: string): StackRpcError => ({ tag, message });

const stateErrorMessage = (error: StackError | { readonly message?: string }): string =>
  typeof error.message === "string" ? error.message : "Stack operation failed";

export const makeSupervisor = (options: SupervisorOptions): Supervisor => {
  const read = options.stateStore
    .read(options.stackId)
    .pipe(Effect.provideContext(options.context));
  const status = read.pipe(
    Effect.flatMap((state) =>
      state === undefined
        ? Effect.fail(new StackStateInvalidError({ message: "Stack state is missing" }))
        : statusFor(state),
    ),
  );

  const stop = read.pipe(
    Effect.flatMap((state) => {
      if (state === undefined)
        return Effect.fail(new StackStateInvalidError({ message: "Stack state is missing" }));
      if (state.desiredLifecycle === "unconfigured" || state.desiredLifecycle === "stopped")
        return Effect.void;
      return options.stateStore
        .replace(
          options.stackId,
          {
            ...state,
            desiredLifecycle: "stopped",
            desiredGeneration: state.desiredGeneration + 1,
          },
          state.desiredGeneration,
        )
        .pipe(Effect.provideContext(options.context));
    }),
  );

  const maintenanceHandlers = {
    probe: Effect.succeed({
      ok: true,
      op: "probe",
      ownerSessionId: options.ownerSessionId,
      stackId: options.stackId,
      rpcRelease: options.rpcRelease,
    } satisfies MaintenanceResponse),
    stop: stop.pipe(
      Effect.as({ ok: true, op: "stop" } satisfies MaintenanceResponse),
      Effect.orElseSucceed(
        () =>
          ({
            ok: false,
            error: { tag: "operation-failed", message: "Unable to stop stack" },
          }) satisfies MaintenanceResponse,
      ),
    ),
    quiesce: Effect.succeed({ ok: true, op: "quiesce" } satisfies MaintenanceResponse),
  };

  const rpcHandlers: StackRpcHandlers = StackRpcGroup.of({
    status: () =>
      status.pipe(
        Effect.mapError((error) => rpcError("StackStateInvalidError", stateErrorMessage(error))),
      ),
    credentials: () => Effect.fail(rpcError("StackNotRunningError", "Stack is not running")),
    prepare: () =>
      Effect.fail(rpcError("StackPreparationError", "Stack preparation is not available yet")),
    start: () =>
      read.pipe(
        Effect.mapError(() => rpcError("StackStateInvalidError", "Unable to read stack state")),
        Effect.flatMap((state) =>
          state?.definition === undefined
            ? Effect.fail(
                rpcError(
                  "StackDefinitionRequiredError",
                  "A stack definition is required before starting",
                ),
              )
            : Effect.fail(
                rpcError("StackReconciliationError", "Stack runtime is not available yet"),
              ),
        ),
      ),
    restart: () =>
      read.pipe(
        Effect.mapError(() => rpcError("StackStateInvalidError", "Unable to read stack state")),
        Effect.flatMap((state) =>
          state?.definition === undefined
            ? Effect.fail(
                rpcError(
                  "StackDefinitionRequiredError",
                  "A stack definition is required before restarting",
                ),
              )
            : Effect.fail(
                rpcError("StackReconciliationError", "Stack runtime is not available yet"),
              ),
        ),
      ),
    destroy: () =>
      Effect.fail(rpcError("StackDestructionError", "Stack destruction is not available yet")),
    logs: () => Stream.fail(rpcError("StackNotRunningError", "Stack logs are not available yet")),
    watchStatus: () =>
      Stream.fromEffect(
        status.pipe(
          Effect.mapError((error) => rpcError("StackStateInvalidError", stateErrorMessage(error))),
        ),
      ),
  });

  return {
    identity: options.identity,
    stackId: options.stackId,
    ownerSessionId: options.ownerSessionId,
    status,
    maintenanceHandlers,
    rpcHandlers,
  };
};
