import { createServer, type Server } from "node:net";
import { Data, Effect, Schema, Semaphore } from "effect";
import { PortSetSchema, type PortField, type PortSet } from "./PortCatalog.ts";

export class PortAllocationError extends Data.TaggedError("PortAllocationError")<{
  readonly detail: string;
  readonly cause?: unknown;
  readonly field?: PortField;
  readonly port?: number;
}> {
  override get message(): string {
    return this.detail;
  }
}

export type PortSelection =
  | { readonly kind: "exact"; readonly port: number }
  | { readonly kind: "automatic"; readonly preferred?: number };

export interface PortReservationRequest {
  readonly field: PortField;
  readonly selection: PortSelection;
}

export interface PortSelectionOptions {
  readonly reserved?: ReadonlySet<number>;
  /** Additional exclusions applied only to requests for the given field. */
  readonly reservedByField?: ReadonlyMap<PortField, ReadonlySet<number>>;
}

interface BoundPort {
  readonly port: number;
  readonly server: Server;
}

/** Close a reservation only after its server has stopped listening. */
const closeServer = (server: Server): Effect.Effect<void> =>
  Effect.callback<void>((resume) => {
    if (!server.listening) {
      resume(Effect.void);
      return Effect.void;
    }
    server.close((cause) => resume(cause === undefined ? Effect.void : Effect.die(cause)));
    return Effect.void;
  });

/**
 * Bind the port that will be held by a lease.
 *
 * This is the only allocation primitive. Unlike a bind/close probe, the bound
 * server remains owned by the returned lease until it is explicitly released.
 */
const bindPort = (port: number): Effect.Effect<BoundPort, PortAllocationError> =>
  Effect.callback<BoundPort, PortAllocationError>((resume) => {
    const server = createServer((socket) => socket.destroy());
    const onError = (cause: unknown) => {
      server.off("error", onError);
      resume(
        Effect.fail(
          new PortAllocationError({
            detail:
              port === 0 ? "Failed to reserve a random port" : `Port ${port} is not available`,
            cause,
            ...(port === 0 ? {} : { port }),
          }),
        ),
      );
    };
    server.once("error", onError);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", onError);
      const address = server.address();
      if (address === null || typeof address === "string") {
        resume(
          closeServer(server).pipe(
            Effect.andThen(
              Effect.fail(
                new PortAllocationError({ detail: "Reserved TCP port has no numeric address" }),
              ),
            ),
          ),
        );
        return;
      }
      resume(Effect.succeed({ port: address.port, server }));
    });

    // Effect.callback runs this finalizer if the fiber is interrupted while the
    // OS bind is pending. That closes the exact server created by this attempt.
    return closeServer(server);
  });

const uniqueFields = (
  requests: ReadonlyArray<PortReservationRequest>,
): ReadonlyArray<PortReservationRequest> => {
  const seen = new Set<PortField>();
  return requests.filter((request) => {
    if (seen.has(request.field)) return false;
    seen.add(request.field);
    return true;
  });
};

const uniquePortFields = (fields: ReadonlyArray<PortField>): ReadonlyArray<PortField> => {
  const seen = new Set<PortField>();
  return fields.filter((field) => {
    if (seen.has(field)) return false;
    seen.add(field);
    return true;
  });
};

const withPortField = (field: PortField, error: PortAllocationError): PortAllocationError =>
  new PortAllocationError({
    detail: error.detail,
    cause: error.cause,
    field,
    ...(error.port === undefined ? {} : { port: error.port }),
  });

const validatePort = (
  field: PortField,
  port: number,
): Effect.Effect<number, PortAllocationError> =>
  Number.isInteger(port) && port >= 1 && port <= 65_535
    ? Effect.succeed(port)
    : Effect.fail(
        new PortAllocationError({
          detail: `Port ${port} is not a valid TCP port`,
          field,
          port,
        }),
      );

const releaseReservations = (
  reservations: Map<PortField, Server>,
  fields: ReadonlyArray<PortField>,
): Effect.Effect<void> =>
  // A release is cleanup, so do not leave the ownership map half-mutated when
  // its caller is interrupted. Close first, then forget ownership.
  Effect.uninterruptible(
    Effect.forEach(
      uniquePortFields(fields),
      (field) => {
        const server = reservations.get(field);
        if (server === undefined) return Effect.void;
        return closeServer(server).pipe(
          Effect.tap(() => Effect.sync(() => reservations.delete(field))),
        );
      },
      { discard: true },
    ),
  );

const reserveRandomPort = (
  exclude: ReadonlySet<number>,
): Effect.Effect<BoundPort, PortAllocationError> =>
  Effect.flatMap(bindPort(0), (bound) =>
    exclude.has(bound.port)
      ? closeServer(bound.server).pipe(Effect.andThen(reserveRandomPort(exclude)))
      : Effect.succeed(bound),
  );

const reserveOne = (
  request: PortReservationRequest,
  exclude: ReadonlySet<number>,
): Effect.Effect<BoundPort, PortAllocationError> => {
  const selection = request.selection;
  if (selection.kind === "exact") {
    return validatePort(request.field, selection.port).pipe(
      Effect.flatMap((port) => {
        if (exclude.has(port)) {
          return Effect.fail(
            new PortAllocationError({
              detail: `Port ${port} is not available`,
              field: request.field,
              port,
            }),
          );
        }
        return bindPort(port);
      }),
    );
  }

  if (selection.preferred === undefined || exclude.has(selection.preferred)) {
    return reserveRandomPort(exclude);
  }

  return validatePort(request.field, selection.preferred).pipe(
    Effect.flatMap((preferred) =>
      bindPort(preferred).pipe(
        Effect.catchTag("PortAllocationError", () => reserveRandomPort(exclude)),
      ),
    ),
  );
};

const reserveReservations = (
  ports: PortSet,
  reservations: Map<PortField, Server>,
  fields: ReadonlyArray<PortField>,
): Effect.Effect<void, PortAllocationError> =>
  Effect.suspend(() => {
    const acquired: Array<PortField> = [];
    return Effect.forEach(
      uniquePortFields(fields),
      (field) => {
        if (reservations.has(field)) return Effect.void;
        const port = ports[field];
        if (port === undefined) {
          return Effect.fail(
            new PortAllocationError({
              detail: `Port field ${field} was not allocated`,
              field,
            }),
          );
        }
        return Effect.uninterruptibleMask((restore) =>
          restore(bindPort(port)).pipe(
            Effect.mapError((error) => withPortField(field, error)),
            Effect.tap(({ server }) =>
              Effect.sync(() => {
                reservations.set(field, server);
                acquired.push(field);
              }),
            ),
          ),
        );
      },
      { discard: true },
    ).pipe(Effect.onError(() => releaseReservations(reservations, acquired)));
  });

export interface PortLease {
  readonly ports: PortSet;
  readonly reserve: (fields: ReadonlyArray<PortField>) => Effect.Effect<void, PortAllocationError>;
  readonly release: (fields: ReadonlyArray<PortField>) => Effect.Effect<void>;
  readonly releaseAll: Effect.Effect<void>;
}

const makePortLease = (ports: PortSet, reservations: Map<PortField, Server>): PortLease => {
  const lock = Semaphore.makeUnsafe(1);
  return {
    ports,
    reserve: (fields) => lock.withPermit(reserveReservations(ports, reservations, fields)),
    release: (fields) => lock.withPermit(releaseReservations(reservations, fields)),
    releaseAll: lock.withPermit(
      Effect.suspend(() => releaseReservations(reservations, [...reservations.keys()])),
    ),
  };
};

const decodePortSet = (
  partial: Partial<Record<PortField, number>>,
): Effect.Effect<PortSet, PortAllocationError> =>
  Schema.decodeUnknownEffect(PortSetSchema)(partial).pipe(
    Effect.mapError(
      (cause) =>
        new PortAllocationError({
          detail: "Allocated ports did not match the port catalog",
          cause,
        }),
    ),
  );

/**
 * Select and hold one socket for every requested field. Automatic selections
 * may fall back from a preferred port before the first successful start; once
 * returned, the lease is the sole owner of every selected port.
 */
export const reservePortSet = (
  requests: ReadonlyArray<PortReservationRequest>,
  options: PortSelectionOptions = {},
): Effect.Effect<PortLease, PortAllocationError> =>
  Effect.suspend(() => {
    const reservations = new Map<PortField, Server>();
    const allocated = new Set<number>();
    const partial: Partial<Record<PortField, number>> = {};
    const reserved = options.reserved ?? new Set<number>();

    const reserve = Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        for (const request of uniqueFields(requests)) {
          const exclude = new Set([
            ...reserved,
            ...allocated,
            ...(options.reservedByField?.get(request.field) ?? []),
          ]);
          // The OS bind remains interruptible. Once it succeeds, registration
          // and ownership bookkeeping are masked as one handoff.
          const bound = yield* restore(reserveOne(request, exclude)).pipe(
            Effect.mapError((error) => withPortField(request.field, error)),
          );
          reservations.set(request.field, bound.server);
          allocated.add(bound.port);
          partial[request.field] = bound.port;
        }

        const ports = yield* decodePortSet(partial);
        return makePortLease(ports, reservations);
      }),
    );

    return reserve.pipe(
      Effect.onError(() => releaseReservations(reservations, [...reservations.keys()])),
    );
  });
