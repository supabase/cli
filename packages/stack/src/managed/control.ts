import { Data, Effect, Context, Ref, Result, Schedule, Schema } from "effect";
import { HttpServer } from "effect/unstable/http";
import {
  ControlOwnerStatusSchema,
  type ControlOwnerStatus,
  type ControlOwnerState,
} from "../DaemonProtocol.ts";

export type { ControlOwnerState, ControlOwnerStatus } from "../DaemonProtocol.ts";

/** The owner status path exposed once the daemon routes are installed. */
export const CONTROL_STATUS_PATH = "/owner";

const CONTROL_PROTOCOL_VERSION = 1 as const;
const CONTROL_ID_PATTERN = /^[0-9a-f]{64}$/;

export interface ControlEndpoint {
  readonly _tag: "Loopback";
  readonly hostname: string;
  readonly host: string;
  readonly port: number;
  readonly url: string;
  /** The persisted transport spelling used by stack documents and clients. */
  readonly path: string;
}

const controlOwnershipBrand: unique symbol = Symbol("stack/ControlOwnership");

export class InvalidControlOwnershipIdError extends Data.TaggedError(
  "InvalidControlOwnershipIdError",
)<{
  readonly ownershipId: string;
}> {
  override get message(): string {
    return "Control ownership ids must be 64 lowercase hexadecimal characters";
  }
}

export class ControlBindError extends Data.TaggedError("ControlBindError")<{
  readonly endpoint: ControlEndpoint;
  readonly reason: "in-use" | "failed";
  readonly cause: unknown;
}> {}

export class ControlTransportError extends Data.TaggedError("ControlTransportError")<{
  readonly endpoint: ControlEndpoint;
  readonly reason: "unreachable" | "transport";
  readonly cause: unknown;
}> {}

export class ControlProtocolError extends Data.TaggedError("ControlProtocolError")<{
  readonly endpoint: ControlEndpoint;
  readonly cause: unknown;
}> {}

export class ControlProtocolMismatchError extends Data.TaggedError("ControlProtocolMismatchError")<{
  readonly endpoint: ControlEndpoint;
  readonly expectedVersion: 1;
  readonly observedVersion: number | undefined;
}> {
  override get message(): string {
    return `Control protocol mismatch: expected ${this.expectedVersion}, observed ${String(this.observedVersion)}`;
  }
}

export class ControlAddressConflictError extends Data.TaggedError("ControlAddressConflictError")<{
  readonly endpoint: ControlEndpoint;
  readonly cause: unknown;
}> {
  override get message(): string {
    return `Control endpoint ${this.endpoint.path} is occupied by a non-Supabase listener`;
  }
}

class ControlUnavailableError extends Data.TaggedError("ControlUnavailableError")<{
  readonly endpoint: ControlEndpoint;
  readonly cause: unknown;
}> {}

export interface ControlListener {
  readonly server: HttpServer.HttpServer["Service"];
  readonly close: Effect.Effect<void>;
}

export interface ControlTransportShape {
  readonly bind: (
    endpoint: ControlEndpoint,
  ) => Effect.Effect<ControlListener, ControlBindError, import("effect/Scope").Scope>;
  readonly read: (
    endpoint: ControlEndpoint,
  ) => Effect.Effect<unknown, ControlTransportError | ControlProtocolError>;
}

/** Runtime-specific loopback bind/connect operations supplied by Node or Bun. */
export class ControlTransport extends Context.Service<ControlTransport, ControlTransportShape>()(
  "stack/ControlTransport",
) {}

export interface ControlOwnershipInput {
  readonly stackId: string;
  readonly runtimeRoot?: string;
  readonly initialStatus?: ControlOwnerStatus;
}

export interface ControlOwnership {
  readonly _tag: "Owned";
  readonly [controlOwnershipBrand]: true;
  readonly endpoint: ControlEndpoint;
  readonly server: HttpServer.HttpServer["Service"];
  readonly ownerStatus: Effect.Effect<ControlOwnerStatus>;
  readonly setOwnerStatus: (status: ControlOwnerStatus) => Effect.Effect<void>;
  readonly setState: (state: ControlOwnerState, ready?: boolean) => Effect.Effect<void>;
  readonly close: Effect.Effect<void>;
  readonly acquiredAfterClose: boolean;
}

export type ControlOwned = ControlOwnership;

export interface ControlAttached {
  readonly _tag: "Attached";
  readonly endpoint: ControlEndpoint;
  readonly ownerStatus: Effect.Effect<
    ControlOwnerStatus,
    ControlTransportError | ControlProtocolError | ControlProtocolMismatchError
  >;
}

export type ControlAcquisition = ControlOwned | ControlAttached;

const invalidId = (ownershipId: string): Effect.Effect<never, InvalidControlOwnershipIdError> =>
  Effect.fail(new InvalidControlOwnershipIdError({ ownershipId }));

const ownershipBytes = (ownershipId: string): ReadonlyArray<number> => {
  const bytes: Array<number> = [];
  for (let index = 0; index < ownershipId.length; index += 2) {
    bytes.push(Number.parseInt(ownershipId.slice(index, index + 2), 16));
  }
  return bytes;
};

/** Derives a deterministic loopback address and high port from a stack id. */
export const controlEndpoint = (
  ownershipId: string,
): Effect.Effect<ControlEndpoint, InvalidControlOwnershipIdError> => {
  if (!CONTROL_ID_PATTERN.test(ownershipId)) return invalidId(ownershipId);
  const bytes = ownershipBytes(ownershipId);
  const value = (bytes[3]! << 8) | bytes[4]!;
  const port = 49152 + (value % 16384);
  const host = "127.0.0.1";
  const url = `http://${host}:${port}`;
  return Effect.succeed({
    _tag: "Loopback",
    hostname: host,
    host,
    port,
    url,
    path: url,
  });
};

/**
 * Returns the persisted spelling of the deterministic loopback control
 * endpoint. `runtimeRoot` is accepted so callers can derive it alongside
 * their runtime paths; ownership itself never creates or claims a file there.
 */
export const controlEndpointPath = (runtimeRoot: string, stackId: string): string => {
  void runtimeRoot;
  const bytes = ownershipBytes(stackId);
  if (!CONTROL_ID_PATTERN.test(stackId) || bytes.length < 5) {
    throw new InvalidControlOwnershipIdError({ ownershipId: stackId });
  }
  const value = (bytes[3]! << 8) | bytes[4]!;
  return `http://127.0.0.1:${49152 + (value % 16384)}`;
};

const decodeOwnerStatus = (
  endpoint: ControlEndpoint,
  value: unknown,
): Effect.Effect<ControlOwnerStatus, ControlProtocolError | ControlProtocolMismatchError> => {
  if (
    typeof value === "object" &&
    value !== null &&
    "protocolVersion" in value &&
    typeof value.protocolVersion === "number" &&
    value.protocolVersion !== CONTROL_PROTOCOL_VERSION
  ) {
    return Effect.fail(
      new ControlProtocolMismatchError({
        endpoint,
        expectedVersion: CONTROL_PROTOCOL_VERSION,
        observedVersion: value.protocolVersion,
      }),
    );
  }
  return Schema.decodeUnknownEffect(ControlOwnerStatusSchema)(value).pipe(
    Effect.mapError(() => new ControlProtocolError({ endpoint, cause: value })),
  );
};

const defaultStatus = (status: ControlOwnerStatus | undefined): ControlOwnerStatus =>
  status ?? { protocolVersion: CONTROL_PROTOCOL_VERSION, state: "starting", ready: false };

const unavailable = (endpoint: ControlEndpoint, cause: unknown): ControlUnavailableError =>
  new ControlUnavailableError({ endpoint, cause });

const attach = (
  endpoint: ControlEndpoint,
  transport: ControlTransportShape,
): Effect.Effect<
  ControlAttached,
  ControlTransportError | ControlProtocolError | ControlProtocolMismatchError
> =>
  transport
    .read(endpoint)
    .pipe(Effect.flatMap((value) => decodeOwnerStatus(endpoint, value)))
    .pipe(
      Effect.map(() => ({
        _tag: "Attached" as const,
        endpoint,
        ownerStatus: transport
          .read(endpoint)
          .pipe(Effect.flatMap((value) => decodeOwnerStatus(endpoint, value))),
      })),
    );

const makeOwned = (
  endpoint: ControlEndpoint,
  listener: ControlListener,
  statusRef: Ref.Ref<ControlOwnerStatus>,
  acquiredAfterClose: boolean,
): Effect.Effect<ControlOwned> => {
  let closed = false;
  const close = Effect.suspend(() => {
    if (closed) return Effect.void;
    closed = true;
    return listener.close;
  });
  return Effect.succeed({
    _tag: "Owned",
    [controlOwnershipBrand]: true,
    endpoint,
    server: listener.server,
    ownerStatus: Ref.get(statusRef),
    setOwnerStatus: (status) => Ref.set(statusRef, status),
    setState: (state, ready = state === "running") =>
      Ref.set(statusRef, { protocolVersion: CONTROL_PROTOCOL_VERSION, state, ready }),
    close,
    acquiredAfterClose,
  });
};

const acquireAtEndpoint = (
  endpoint: ControlEndpoint,
  status: ControlOwnerStatus,
  transport: ControlTransportShape,
): Effect.Effect<
  ControlAcquisition,
  | ControlBindError
  | ControlTransportError
  | ControlProtocolError
  | ControlProtocolMismatchError
  | ControlAddressConflictError,
  import("effect/Scope").Scope
> => {
  const statusRef = Ref.makeUnsafe(status);
  let hadConflict = false;
  const attempt: Effect.Effect<
    ControlAcquisition,
    | ControlBindError
    | ControlTransportError
    | ControlProtocolError
    | ControlProtocolMismatchError
    | ControlUnavailableError,
    import("effect/Scope").Scope
  > = Effect.gen(function* () {
    const bound = yield* transport.bind(endpoint).pipe(Effect.result);
    if (Result.isSuccess(bound)) {
      const owned = yield* makeOwned(endpoint, bound.success, statusRef, hadConflict);
      yield* Effect.addFinalizer(() => owned.close);
      return owned;
    }
    const error = bound.failure;
    if (error.reason !== "in-use") return yield* Effect.fail(error);
    hadConflict = true;
    return yield* attach(endpoint, transport).pipe(
      Effect.mapError((cause) =>
        cause._tag === "ControlTransportError" && cause.reason === "unreachable"
          ? unavailable(endpoint, cause)
          : cause,
      ),
    );
  });

  return attempt.pipe(
    Effect.retry({
      schedule: Schedule.spaced("5 millis").pipe(Schedule.upTo({ times: 40 })),
      while: (error) => error._tag === "ControlUnavailableError",
    }),
    Effect.catchTag("ControlUnavailableError", (error) =>
      Effect.fail(new ControlAddressConflictError({ endpoint, cause: error.cause })),
    ),
  );
};

/** Acquires the deterministic loopback listener or attaches to its owner. */
export const acquireControl = (
  input: ControlOwnershipInput,
): Effect.Effect<
  ControlAcquisition,
  | InvalidControlOwnershipIdError
  | ControlBindError
  | ControlTransportError
  | ControlProtocolError
  | ControlProtocolMismatchError
  | ControlAddressConflictError,
  ControlTransport | import("effect/Scope").Scope
> =>
  Effect.gen(function* () {
    const endpoint = yield* controlEndpoint(input.stackId);
    const transport = yield* ControlTransport;
    return yield* acquireAtEndpoint(endpoint, defaultStatus(input.initialStatus), transport);
  });

export const protocolVersion = CONTROL_PROTOCOL_VERSION;
