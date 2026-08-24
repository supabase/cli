import { Data, Effect, Context, Predicate, Ref, Result, Schedule, Schema } from "effect";
import { HttpServer, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import {
  CONTROL_PROTOCOL,
  CONTROL_PROTOCOL_VERSION,
  ControlOwnerStatusSchema,
  type ControlOwnerStatus,
  type ControlOwnerState,
  type ControlStopRequest,
} from "../DaemonProtocol.ts";
import { StopTimeout } from "../errors.ts";

export type {
  ControlOwnerState,
  ControlOwnerStatus,
  ControlStopRequest,
} from "../DaemonProtocol.ts";
export { ControlStopRequestSchema } from "../DaemonProtocol.ts";

/** The owner status path exposed once the daemon routes are installed. */
export const CONTROL_STATUS_PATH = "/owner";
/** The early shutdown path exposed by the deterministic control listener. */
export const CONTROL_STOP_PATH = "/stop";

const CONTROL_ID_PATTERN = /^[0-9a-f]{64}$/;

/** Reserved loopback TCP range for deterministic managed control endpoints. */
export const CONTROL_PORT_RANGE = { min: 10_000, max: 32_767 } as const;

export interface ControlEndpoint {
  readonly hostname: string;
  readonly port: number;
  readonly url: string;
}

export interface ControlApplication {
  readonly app: Effect.Effect<
    HttpServerResponse.HttpServerResponse,
    never,
    HttpServerRequest.HttpServerRequest | import("effect/Scope").Scope
  >;
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

/** A fenced stop reached an owner other than the captured session. */
export class ControlStopConflictError extends Data.TaggedError("ControlStopConflictError")<{
  readonly endpoint: ControlEndpoint;
}> {}

export class ControlProtocolMismatchError extends Data.TaggedError("ControlProtocolMismatchError")<{
  readonly endpoint: ControlEndpoint;
  readonly expectedVersion: 1;
  readonly observedVersion: number | undefined;
  readonly expectedProtocol: typeof CONTROL_PROTOCOL;
  readonly observedProtocol: string | undefined;
}> {
  override get message(): string {
    return `Control protocol mismatch: expected ${this.expectedProtocol}/${this.expectedVersion}, observed ${String(this.observedProtocol)}/${String(this.observedVersion)}`;
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

class ControlStopPending extends Data.TaggedError("ControlStopPending")<{
  readonly state: ControlOwnerState;
}> {}

interface ControlListener {
  readonly server: HttpServer.HttpServer["Service"];
  readonly close: Effect.Effect<void>;
}

export interface ControlClientTransport {
  readonly read: (
    endpoint: ControlEndpoint,
  ) => Effect.Effect<unknown, ControlTransportError | ControlProtocolError>;
  readonly requestStop: (
    endpoint: ControlEndpoint,
    request: ControlStopRequest,
  ) => Effect.Effect<void, ControlTransportError | ControlProtocolError | ControlStopConflictError>;
}

export interface ControlTransportShape extends ControlClientTransport {
  readonly bind: (
    endpoint: ControlEndpoint,
    ownerStatus: () => ControlOwnerStatus,
    onStop: (request: ControlStopRequest) => "accepted" | "conflict" | "invalid",
    application?: ControlApplication,
  ) => Effect.Effect<ControlListener, ControlBindError, import("effect/Scope").Scope>;
}

/** Runtime-specific loopback bind/connect operations supplied by Node or Bun. */
export class ControlTransport extends Context.Service<ControlTransport, ControlTransportShape>()(
  "stack/ControlTransport",
) {}

export interface ControlOwnershipInput {
  readonly stackId: string;
  readonly initialStatus?: ControlOwnerStatus;
  readonly application?: ControlApplication;
}

export interface ControlOwnership {
  readonly _tag: "Owned";
  readonly [controlOwnershipBrand]: true;
  readonly ownershipId: string;
  readonly endpoint: ControlEndpoint;
  readonly ownerStatus: Effect.Effect<ControlOwnerStatus>;
  readonly close: Effect.Effect<void>;
}

export interface ControlAttached {
  readonly _tag: "Attached";
  readonly ownershipId: string;
  readonly endpoint: ControlEndpoint;
  /** Status decoded during the ownership handshake before the result escaped. */
  readonly observedStatus: ControlOwnerStatus;
  readonly ownerStatus: Effect.Effect<
    ControlOwnerStatus,
    | ControlTransportError
    | ControlProtocolError
    | ControlProtocolMismatchError
    | ControlAddressConflictError
  >;
  readonly requestStop: Effect.Effect<
    void,
    | ControlTransportError
    | ControlProtocolError
    | ControlProtocolMismatchError
    | ControlAddressConflictError
    | StopTimeout
  >;
}

export type ControlAcquisition = ControlOwnership | ControlAttached;

export const isControlOwnership = (
  acquisition: ControlAcquisition,
): acquisition is ControlOwnership => Predicate.isTagged(acquisition, "Owned");

export const isControlAttached = (
  acquisition: ControlAcquisition,
): acquisition is ControlAttached => Predicate.isTagged(acquisition, "Attached");

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

/** Waits until the exact owner session disappears after an accepted stop. */
const waitForControlSessionEnd = (
  endpoint: ControlEndpoint,
  ownershipId: string,
  ownerSessionId: string,
  read: Effect.Effect<
    ControlOwnerStatus,
    | ControlTransportError
    | ControlProtocolError
    | ControlProtocolMismatchError
    | ControlAddressConflictError
  >,
): Effect.Effect<
  void,
  | ControlTransportError
  | ControlProtocolError
  | ControlProtocolMismatchError
  | ControlAddressConflictError
  | StopTimeout
> =>
  Effect.gen(function* () {
    const lastState = yield* Ref.make<ControlOwnerState | undefined>(undefined);
    const observe = read.pipe(
      Effect.flatMap((current) =>
        current.ownershipId === ownershipId && current.ownerSessionId === ownerSessionId
          ? Ref.set(lastState, current.state).pipe(
              Effect.andThen(Effect.fail(new ControlStopPending({ state: current.state }))),
            )
          : Effect.void,
      ),
      Effect.catchTag("ControlTransportError", (error) =>
        error.reason === "unreachable"
          ? Effect.void
          : Ref.get(lastState).pipe(
              Effect.flatMap((state) =>
                Effect.fail(new ControlStopPending({ state: state ?? "stopping" })),
              ),
            ),
      ),
    );
    return yield* observe.pipe(
      Effect.retry({
        schedule: Schedule.spaced("25 millis").pipe(Schedule.upTo({ duration: "30 seconds" })),
        while: (error) => Predicate.isTagged(error, "ControlStopPending"),
      }),
      Effect.catchTag("ControlStopPending", (error) =>
        Effect.fail(
          new StopTimeout({ endpoint: endpoint.url, ownerSessionId, lastState: error.state }),
        ),
      ),
    );
  });

/**
 * Sends a fenced stop to one already-verified owner session and waits for that
 * exact session to disappear. Callers that have only an ownership id should
 * re-probe before invoking this helper; the session fence must never be
 * refreshed after the stop request is accepted.
 */
export const requestControlStopForSession = (
  endpoint: ControlEndpoint,
  ownershipId: string,
  ownerSessionId: string,
  transport: ControlClientTransport,
): Effect.Effect<
  void,
  | ControlTransportError
  | ControlProtocolError
  | ControlProtocolMismatchError
  | ControlAddressConflictError
  | StopTimeout
> =>
  transport.requestStop(endpoint, { ownershipId, ownerSessionId }).pipe(
    // The stop POST has an ambiguous delivery result: the peer may have
    // accepted it and closed the connection before the response arrived.
    // Observe the exact captured session instead of failing or refreshing the
    // descriptor; a still-live session will reach the existing timeout.
    Effect.catchTags({
      ControlTransportError: () => Effect.void,
      ControlStopConflictError: () => Effect.void,
    }),
    Effect.flatMap(() =>
      waitForControlSessionEnd(
        endpoint,
        ownershipId,
        ownerSessionId,
        readControlOwnerStatus(endpoint, ownershipId, transport.read),
      ),
    ),
  );

const decodeOwnerStatus = (
  endpoint: ControlEndpoint,
  value: unknown,
): Effect.Effect<ControlOwnerStatus, ControlProtocolError | ControlProtocolMismatchError> => {
  if (typeof value === "object" && value !== null) {
    const observedVersion =
      "controlProtocolVersion" in value && typeof value.controlProtocolVersion === "number"
        ? value.controlProtocolVersion
        : undefined;
    const observedProtocol =
      "controlProtocol" in value && typeof value.controlProtocol === "string"
        ? value.controlProtocol
        : undefined;
    const hasVersion = "controlProtocolVersion" in value;
    const hasProtocol = "controlProtocol" in value;
    if (
      (hasVersion && observedVersion !== CONTROL_PROTOCOL_VERSION) ||
      (hasProtocol && observedProtocol !== CONTROL_PROTOCOL)
    ) {
      return Effect.fail(
        new ControlProtocolMismatchError({
          endpoint,
          expectedVersion: CONTROL_PROTOCOL_VERSION,
          observedVersion,
          expectedProtocol: CONTROL_PROTOCOL,
          observedProtocol,
        }),
      );
    }
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
    ? {
        controlProtocol: CONTROL_PROTOCOL,
        controlProtocolVersion: CONTROL_PROTOCOL_VERSION,
        ownershipId,
        ownerSessionId: crypto.randomUUID(),
        state: "starting",
        ready: false,
        daemonCliVersion: "unknown",
      }
    : {
        ...status,
        controlProtocol: CONTROL_PROTOCOL,
        controlProtocolVersion: CONTROL_PROTOCOL_VERSION,
        ownershipId,
      };

const unavailable = (endpoint: ControlEndpoint, cause: unknown): ControlUnavailableError =>
  new ControlUnavailableError({ endpoint, cause });

export type ControlOwnerReader = (
  endpoint: ControlEndpoint,
) => Effect.Effect<unknown, ControlTransportError | ControlProtocolError>;

/** Reads and verifies one exact owner through a supplied control transport. */
export const readControlOwnerStatus = (
  endpoint: ControlEndpoint,
  ownershipId: string,
  read: ControlOwnerReader,
): Effect.Effect<
  ControlOwnerStatus,
  | ControlTransportError
  | ControlProtocolError
  | ControlProtocolMismatchError
  | ControlAddressConflictError
> =>
  read(endpoint).pipe(
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

export interface ControlClientShape {
  readonly readOwner: (
    endpoint: ControlEndpoint,
    ownershipId: string,
  ) => Effect.Effect<
    ControlOwnerStatus,
    | ControlTransportError
    | ControlProtocolError
    | ControlProtocolMismatchError
    | ControlAddressConflictError
  >;
  readonly stopSession: (
    endpoint: ControlEndpoint,
    ownershipId: string,
    ownerSessionId: string,
  ) => Effect.Effect<
    void,
    | ControlTransportError
    | ControlProtocolError
    | ControlProtocolMismatchError
    | ControlAddressConflictError
    | StopTimeout
  >;
}

/** Stable owner/session client shared by platform and remote HTTP transports. */
export const makeControlClient = (transport: ControlClientTransport): ControlClientShape => ({
  readOwner: (endpoint, ownershipId) =>
    readControlOwnerStatus(endpoint, ownershipId, transport.read),
  stopSession: (endpoint, ownershipId, ownerSessionId) =>
    requestControlStopForSession(endpoint, ownershipId, ownerSessionId, transport),
});

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
      const status = yield* readControlOwnerStatus(endpoint, ownershipId, transport.read).pipe(
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
  observedStatus: ControlOwnerStatus,
): ControlAttached => {
  const client = makeControlClient(transport);
  const ownerStatus = client.readOwner(endpoint, ownershipId);
  const requestStop = client.stopSession(endpoint, ownershipId, observedStatus.ownerSessionId);
  return {
    _tag: "Attached",
    ownershipId,
    endpoint,
    observedStatus,
    ownerStatus,
    requestStop,
  };
};

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
  readControlOwnerStatus(endpoint, ownershipId, transport.read).pipe(
    Effect.map((status) => makeAttached(endpoint, ownershipId, transport, status)),
  );

const makeOwned = (
  endpoint: ControlEndpoint,
  ownershipId: string,
  listener: ControlListener,
  statusRef: Ref.Ref<ControlOwnerStatus>,
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
    ownerStatus: Ref.get(statusRef),
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
): Effect.Effect<ControlProbe | undefined, ControlProtocolMismatchError | ControlTransportError> =>
  Effect.gen(function* () {
    for (const endpoint of candidates) {
      const status = yield* readControlOwnerStatus(endpoint, ownershipId, transport.read).pipe(
        Effect.map((status) => status),
        Effect.catchTag("ControlTransportError", (cause) =>
          cause.reason === "unreachable" ? Effect.succeed(undefined) : Effect.fail(cause),
        ),
        Effect.catchTag("ControlProtocolError", () => Effect.succeed(undefined)),
        Effect.catchTag("ControlAddressConflictError", () => Effect.succeed(undefined)),
      );
      if (status !== undefined) return { endpoint, status };
    }
    return undefined;
  });

const acquireAtCandidates = (
  candidates: ReadonlyArray<ControlEndpoint>,
  ownershipId: string,
  status: ControlOwnerStatus,
  transport: ControlTransportShape,
  application?: ControlApplication,
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
      return makeAttached(ownerEndpoint.endpoint, ownershipId, transport, ownerEndpoint.status);
    }
    let pending: ControlUnavailableError | undefined;
    let conflict: ControlAddressConflictError | undefined;
    for (const endpoint of candidates) {
      const bound = yield* transport
        .bind(
          endpoint,
          () => Ref.getUnsafe(statusRef),
          (request) => {
            if (request === undefined) return "invalid";
            const current = Ref.getUnsafe(statusRef);
            if (
              request.ownershipId !== ownershipId ||
              request.ownerSessionId !== current.ownerSessionId
            ) {
              return "conflict";
            }
            return "accepted";
          },
          application,
        )
        .pipe(Effect.result);
      if (Result.isSuccess(bound)) {
        const owned = yield* makeOwned(endpoint, ownershipId, bound.success, statusRef);
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
      // Bound by duration, not attempts: an attempt's own reads can each
      // consume the 500 ms transport timeout, and a count-based budget would
      // stretch a single acquire far past the parent's startup handshake.
      schedule: Schedule.spaced("50 millis").pipe(Schedule.upTo({ duration: "1500 millis" })),
      while: (error) => Predicate.isTagged(error, "ControlUnavailableError"),
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
      input.application,
    );
  });
