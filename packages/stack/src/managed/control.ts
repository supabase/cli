import { Data, Deferred, Effect, Context, Ref, Result, Schedule, Schema } from "effect";
import { HttpServer } from "effect/unstable/http";
import {
  ControlOwnerStatusSchema,
  type ControlOwnerStatus,
  type ControlOwnerState,
} from "../DaemonProtocol.ts";

export type { ControlOwnerState, ControlOwnerStatus } from "../DaemonProtocol.ts";

/** The owner status path exposed once the daemon routes are installed. */
export const CONTROL_STATUS_PATH = "/owner";
/** The early shutdown path exposed by the deterministic control listener. */
export const CONTROL_STOP_PATH = "/stop";

const CONTROL_PROTOCOL_VERSION = 1 as const;
const CONTROL_ID_PATTERN = /^[0-9a-f]{64}$/;

/** Reserved loopback TCP range for deterministic managed control endpoints. */
export const CONTROL_PORT_RANGE = { min: 10_000, max: 32_767 } as const;

export interface ControlEndpoint {
  readonly hostname: string;
  readonly port: number;
  readonly url: string;
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
    return `Control endpoint ${this.endpoint.url} is occupied by another listener`;
  }
}

class ControlUnavailableError extends Data.TaggedError("ControlUnavailableError")<{
  readonly endpoint: ControlEndpoint;
  readonly cause: unknown;
}> {}

interface ControlListener {
  readonly server: HttpServer.HttpServer["Service"];
  readonly close: Effect.Effect<void>;
}

export interface ControlTransportShape {
  readonly bind: (
    endpoint: ControlEndpoint,
    ownerStatus: () => ControlOwnerStatus,
    onStop: () => void,
  ) => Effect.Effect<ControlListener, ControlBindError, import("effect/Scope").Scope>;
  readonly read: (
    endpoint: ControlEndpoint,
  ) => Effect.Effect<unknown, ControlTransportError | ControlProtocolError>;
  readonly requestStop: (
    endpoint: ControlEndpoint,
  ) => Effect.Effect<void, ControlTransportError | ControlProtocolError>;
}

/** Runtime-specific loopback bind/connect operations supplied by Node or Bun. */
export class ControlTransport extends Context.Service<ControlTransport, ControlTransportShape>()(
  "stack/ControlTransport",
) {}

export interface ControlOwnershipInput {
  readonly stackId: string;
  readonly initialStatus?: ControlOwnerStatus;
}

export interface ControlOwnership {
  readonly _tag: "Owned";
  readonly [controlOwnershipBrand]: true;
  readonly ownershipId: string;
  readonly endpoint: ControlEndpoint;
  readonly server: HttpServer.HttpServer["Service"];
  readonly ownerStatus: Effect.Effect<ControlOwnerStatus>;
  readonly setOwnerStatus: (status: ControlOwnerStatus) => Effect.Effect<void>;
  readonly setState: (state: ControlOwnerState, ready?: boolean) => Effect.Effect<void>;
  readonly requestStop: Effect.Effect<void>;
  readonly stopRequested: Effect.Effect<void>;
  readonly close: Effect.Effect<void>;
}

export interface ControlAttached {
  readonly _tag: "Attached";
  readonly ownershipId: string;
  readonly endpoint: ControlEndpoint;
  readonly ownerStatus: Effect.Effect<
    ControlOwnerStatus,
    | ControlTransportError
    | ControlProtocolError
    | ControlProtocolMismatchError
    | ControlAddressConflictError
  >;
  readonly requestStop: Effect.Effect<void, ControlTransportError | ControlProtocolError>;
}

export type ControlAcquisition = ControlOwnership | ControlAttached;

const invalidId = (ownershipId: string): Effect.Effect<never, InvalidControlOwnershipIdError> =>
  Effect.fail(new InvalidControlOwnershipIdError({ ownershipId }));

const ownershipBytes = (ownershipId: string): ReadonlyArray<number> => {
  const bytes: Array<number> = [];
  for (let index = 0; index < ownershipId.length; index += 2) {
    bytes.push(Number.parseInt(ownershipId.slice(index, index + 2), 16));
  }
  return bytes;
};

/**
 * Number of deterministic endpoints derived per ownership id. Two ids can
 * hash to the same primary port, so owners fall through to the next
 * candidate and readers scan the same sequence, matching on `ownershipId`.
 */
export const CONTROL_CANDIDATE_COUNT = 8;

const CONTROL_RANGE_SIZE = CONTROL_PORT_RANGE.max - CONTROL_PORT_RANGE.min + 1;

const endpointForValue = (value: number): ControlEndpoint => {
  const port = CONTROL_PORT_RANGE.min + (value % CONTROL_RANGE_SIZE);
  const host = "127.0.0.1";
  return { hostname: host, port, url: `http://${host}:${port}` };
};

/** Derives the deterministic loopback endpoint candidates for a stack id. */
export const controlEndpointCandidates = (
  ownershipId: string,
): Effect.Effect<ReadonlyArray<ControlEndpoint>, InvalidControlOwnershipIdError> => {
  if (!CONTROL_ID_PATTERN.test(ownershipId)) return invalidId(ownershipId);
  const bytes = ownershipBytes(ownershipId);
  const value = (bytes[3]! << 8) | bytes[4]!;
  return Effect.succeed(
    Array.from({ length: CONTROL_CANDIDATE_COUNT }, (_, offset) =>
      endpointForValue(value + offset),
    ),
  );
};

/** Derives the primary deterministic endpoint (first candidate) for a stack id. */
export const controlEndpoint = (
  ownershipId: string,
): Effect.Effect<ControlEndpoint, InvalidControlOwnershipIdError> =>
  Effect.map(controlEndpointCandidates(ownershipId), (candidates) => candidates[0]!);

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

const defaultStatus = (
  ownershipId: string,
  status: ControlOwnerStatus | undefined,
): ControlOwnerStatus =>
  status === undefined
    ? { protocolVersion: CONTROL_PROTOCOL_VERSION, ownershipId, state: "starting", ready: false }
    : { ...status, ownershipId };

const unavailable = (endpoint: ControlEndpoint, cause: unknown): ControlUnavailableError =>
  new ControlUnavailableError({ endpoint, cause });

const readOwnerStatus = (
  endpoint: ControlEndpoint,
  ownershipId: string,
  transport: ControlTransportShape,
): Effect.Effect<
  ControlOwnerStatus,
  | ControlTransportError
  | ControlProtocolError
  | ControlProtocolMismatchError
  | ControlAddressConflictError
> =>
  transport.read(endpoint).pipe(
    Effect.flatMap((value) => decodeOwnerStatus(endpoint, value)),
    Effect.flatMap((status) =>
      status.ownershipId === ownershipId
        ? Effect.succeed(status)
        : Effect.fail(
            new ControlAddressConflictError({
              endpoint,
              cause: new Error(
                `Control endpoint is owned by ${status.ownershipId}, not ${ownershipId}`,
              ),
            }),
          ),
    ),
  );

/** A located owner: its published status and the candidate it bound. */
export interface ControlProbe {
  readonly status: ControlOwnerStatus;
  readonly endpoint: ControlEndpoint;
}

/** Reads an existing owner wherever it bound, without claiming an endpoint. */
export const probeControl = (
  ownershipId: string,
): Effect.Effect<ControlProbe | undefined, InvalidControlOwnershipIdError, ControlTransport> =>
  Effect.gen(function* () {
    const candidates = yield* controlEndpointCandidates(ownershipId);
    const transport = yield* ControlTransport;
    for (const endpoint of candidates) {
      const status = yield* readOwnerStatus(endpoint, ownershipId, transport).pipe(
        Effect.catch(() => Effect.succeed(undefined)),
      );
      if (status !== undefined) return { status, endpoint };
    }
    return undefined;
  });

const makeAttached = (
  endpoint: ControlEndpoint,
  ownershipId: string,
  transport: ControlTransportShape,
): ControlAttached => ({
  _tag: "Attached",
  ownershipId,
  endpoint,
  ownerStatus: readOwnerStatus(endpoint, ownershipId, transport),
  requestStop: transport.requestStop(endpoint),
});

const attach = (
  endpoint: ControlEndpoint,
  ownershipId: string,
  transport: ControlTransportShape,
): Effect.Effect<
  ControlAttached,
  | ControlTransportError
  | ControlProtocolError
  | ControlProtocolMismatchError
  | ControlAddressConflictError
> =>
  readOwnerStatus(endpoint, ownershipId, transport).pipe(
    Effect.map(() => makeAttached(endpoint, ownershipId, transport)),
  );

const makeOwned = (
  endpoint: ControlEndpoint,
  ownershipId: string,
  listener: ControlListener,
  statusRef: Ref.Ref<ControlOwnerStatus>,
  stopRequested: Deferred.Deferred<void>,
): Effect.Effect<ControlOwnership> => {
  let closed = false;
  const close = Effect.suspend(() => {
    if (closed) return Effect.void;
    closed = true;
    return listener.close;
  });
  return Effect.succeed({
    _tag: "Owned",
    [controlOwnershipBrand]: true,
    ownershipId,
    endpoint,
    server: listener.server,
    ownerStatus: Ref.get(statusRef),
    setOwnerStatus: (next) => Ref.set(statusRef, { ...next, ownershipId }),
    setState: (state, ready = state === "running") =>
      Ref.set(statusRef, {
        protocolVersion: CONTROL_PROTOCOL_VERSION,
        ownershipId,
        state,
        ready,
      }),
    requestStop: Deferred.succeed(stopRequested, void 0).pipe(Effect.asVoid),
    stopRequested: Deferred.await(stopRequested),
    close,
  });
};

/**
 * Finds the candidate a live owner of `ownershipId` bound, if any. Foreign
 * owners, non-Supabase listeners, and free ports are skipped; a protocol
 * mismatch fails closed because a newer owner of this very stack may be
 * publishing there, and claiming another candidate beside it would split
 * ownership across versions.
 */
const scanForOwner = (
  candidates: ReadonlyArray<ControlEndpoint>,
  ownershipId: string,
  transport: ControlTransportShape,
): Effect.Effect<ControlEndpoint | undefined, ControlProtocolMismatchError> =>
  Effect.gen(function* () {
    for (const endpoint of candidates) {
      const found = yield* readOwnerStatus(endpoint, ownershipId, transport).pipe(
        Effect.map(() => true),
        Effect.catchTag("ControlTransportError", () => Effect.succeed(false)),
        Effect.catchTag("ControlProtocolError", () => Effect.succeed(false)),
        Effect.catchTag("ControlAddressConflictError", () => Effect.succeed(false)),
      );
      if (found) return endpoint;
    }
    return undefined;
  });

const acquireAtCandidates = (
  candidates: ReadonlyArray<ControlEndpoint>,
  ownershipId: string,
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
  const stopRequested = Deferred.makeUnsafe<void>();
  const attempt: Effect.Effect<
    ControlAcquisition,
    | ControlBindError
    | ControlTransportError
    | ControlProtocolError
    | ControlProtocolMismatchError
    | ControlAddressConflictError
    | ControlUnavailableError,
    import("effect/Scope").Scope
  > = Effect.gen(function* () {
    // An existing owner may hold any candidate: an earlier occupant can have
    // freed a lower port since the owner bound. Attach before claiming one so
    // a stack never ends up with two owners on different candidates. The scan
    // read doubles as the attach handshake, so an owner is read exactly once.
    const ownerEndpoint = yield* scanForOwner(candidates, ownershipId, transport);
    if (ownerEndpoint !== undefined) {
      return makeAttached(ownerEndpoint, ownershipId, transport);
    }
    let pending: ControlUnavailableError | undefined;
    let conflict: ControlAddressConflictError | undefined;
    for (const endpoint of candidates) {
      const bound = yield* transport
        .bind(
          endpoint,
          () => Ref.getUnsafe(statusRef),
          () => {
            Effect.runSync(Deferred.succeed(stopRequested, void 0));
          },
        )
        .pipe(Effect.result);
      if (Result.isSuccess(bound)) {
        const owned = yield* makeOwned(
          endpoint,
          ownershipId,
          bound.success,
          statusRef,
          stopRequested,
        );
        yield* Effect.addFinalizer(() => owned.close);
        return owned;
      }
      const error = bound.failure;
      if (error.reason !== "in-use") return yield* Effect.fail(error);
      // The address was taken between the scan and the bind: attach if the
      // occupant is our owner, retry the walk if it is not serving yet, and
      // move to the next candidate if it belongs to someone else.
      const attached: ControlAcquisition | undefined = yield* attach(
        endpoint,
        ownershipId,
        transport,
      ).pipe(
        Effect.map((acquisition): ControlAcquisition | undefined => acquisition),
        Effect.catchTag("ControlAddressConflictError", (cause) =>
          Effect.sync(() => {
            conflict = cause;
            return undefined;
          }),
        ),
        Effect.catchTag("ControlProtocolError", (cause) =>
          Effect.sync(() => {
            conflict = new ControlAddressConflictError({ endpoint, cause });
            return undefined;
          }),
        ),
        Effect.catchTag("ControlTransportError", (cause) =>
          cause.reason === "unreachable"
            ? Effect.sync(() => {
                pending = unavailable(endpoint, cause);
                return undefined;
              })
            : Effect.fail(cause),
        ),
      );
      if (attached !== undefined) return attached;
    }
    if (pending !== undefined) return yield* Effect.fail(pending);
    return yield* Effect.fail(
      conflict ??
        new ControlAddressConflictError({
          endpoint: candidates[0]!,
          cause: new Error("Every control endpoint candidate is occupied"),
        }),
    );
  });

  return attempt.pipe(
    Effect.retry({
      // Leave explicit margin inside the parent's 35-second startup handshake,
      // even when every owner probe consumes its 500 ms transport timeout.
      schedule: Schedule.spaced("50 millis").pipe(Schedule.upTo({ times: 30 })),
      while: (error) => error._tag === "ControlUnavailableError",
    }),
    Effect.catchTag("ControlUnavailableError", (error) =>
      Effect.fail(
        new ControlAddressConflictError({ endpoint: error.endpoint, cause: error.cause }),
      ),
    ),
  );
};

/** Acquires a deterministic loopback listener or attaches to its owner. */
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
    const candidates = yield* controlEndpointCandidates(input.stackId);
    const transport = yield* ControlTransport;
    return yield* acquireAtCandidates(
      candidates,
      input.stackId,
      defaultStatus(input.stackId, input.initialStatus),
      transport,
    );
  });
