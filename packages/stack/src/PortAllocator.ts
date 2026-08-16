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
}

interface PortAllocationOptions extends PortSelectionOptions {
  readonly probe?: PortProbe;
  /** @internal deterministic interruption hook used by allocator integration tests. */
  readonly onBound?: (field: PortField, bound: BoundPort) => Effect.Effect<void>;
}

interface PortProbe {
  readonly exact: (port: number) => Effect.Effect<number, PortAllocationError>;
  readonly random: (exclude: ReadonlySet<number>) => Effect.Effect<number, PortAllocationError>;
}

/** Bind port 0 to get an OS-assigned random port, then close immediately. */
const probeRandomPort = (
  exclude: ReadonlySet<number>,
): Effect.Effect<number, PortAllocationError> =>
  Effect.flatMap(
    Effect.callback<number, PortAllocationError>((resume) => {
      const server = createServer();
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        const port = typeof address === "object" && address !== null ? address.port : 0;
        server.close(() => resume(Effect.succeed(port)));
      });
      server.on("error", (cause) =>
        resume(
          Effect.fail(new PortAllocationError({ detail: "Failed to bind random port", cause })),
        ),
      );
      return Effect.void;
    }),
    (port) => (exclude.has(port) ? probeRandomPort(exclude) : Effect.succeed(port)),
  );

/** Probe the exact port requested by the user. Fail if it is not available. */
const probeExactPort = (port: number): Effect.Effect<number, PortAllocationError> =>
  Effect.callback<number, PortAllocationError>((resume) => {
    const server = createServer();
    server.listen(port, "127.0.0.1", () => {
      server.close(() => resume(Effect.succeed(port)));
    });
    server.on("error", () =>
      resume(
        Effect.fail(new PortAllocationError({ detail: `Port ${port} is not available`, port })),
      ),
    );
    return Effect.void;
  });

const chooseExactPort = (
  port: number,
  exclude: ReadonlySet<number>,
  probe: PortProbe,
): Effect.Effect<number, PortAllocationError> =>
  exclude.has(port)
    ? Effect.fail(new PortAllocationError({ detail: `Port ${port} is not available`, port }))
    : probe.exact(port);

const choosePreferredPort = (
  port: number,
  exclude: ReadonlySet<number>,
  probe: PortProbe,
): Effect.Effect<number, PortAllocationError> =>
  exclude.has(port)
    ? probe.random(exclude)
    : probe.exact(port).pipe(Effect.catchTag("PortAllocationError", () => probe.random(exclude)));

const defaultPortProbe: PortProbe = {
  exact: probeExactPort,
  random: probeRandomPort,
};

const closeServer = (server: Server): Effect.Effect<void> =>
  Effect.callback<void>((resume) => {
    server.close(() => resume(Effect.void));
    return Effect.void;
  });

interface BoundPort {
  readonly port: number;
  readonly server: Server;
}

const bindPort = (port: number): Effect.Effect<BoundPort, PortAllocationError> =>
  Effect.callback<BoundPort, PortAllocationError>((resume) => {
    const server = createServer((socket) => socket.destroy());
    const onError = (cause: unknown) => {
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
        void Effect.runPromise(closeServer(server));
        resume(
          Effect.fail(
            new PortAllocationError({ detail: "Reserved TCP port has no numeric address" }),
          ),
        );
        return;
      }
      resume(Effect.succeed({ port: address.port, server }));
    });
    return closeServer(server);
  });

export interface PortLease {
  readonly ports: PortSet;
  readonly reserve: (fields: ReadonlyArray<PortField>) => Effect.Effect<void, PortAllocationError>;
  readonly release: (fields: ReadonlyArray<PortField>) => Effect.Effect<void>;
  readonly releaseAll: Effect.Effect<void>;
}

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

const releaseReservations = (
  reservations: Map<PortField, Server>,
  fields: ReadonlyArray<PortField>,
): Effect.Effect<void> =>
  Effect.forEach(
    uniquePortFields(fields),
    (field) => {
      const server = reservations.get(field);
      if (server === undefined) return Effect.void;
      reservations.delete(field);
      return closeServer(server);
    },
    { discard: true },
  );

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
        return bindPort(port).pipe(
          Effect.mapError((error) => withPortField(field, error)),
          Effect.tap(({ server }) =>
            Effect.sync(() => {
              reservations.set(field, server);
              acquired.push(field);
            }),
          ),
        );
      },
      { discard: true },
    ).pipe(Effect.onError(() => releaseReservations(reservations, acquired)));
  });

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

const reserveRandomPort = (
  exclude: ReadonlySet<number>,
): Effect.Effect<BoundPort, PortAllocationError> =>
  Effect.flatMap(bindPort(0), (bound) =>
    exclude.has(bound.port)
      ? closeServer(bound.server).pipe(Effect.andThen(reserveRandomPort(exclude)))
      : Effect.succeed(bound),
  );

const resolveSelection = (
  selection: PortSelection,
  exclude: ReadonlySet<number>,
  probe: PortProbe,
): Effect.Effect<number, PortAllocationError> => {
  if (selection.kind === "exact") {
    return chooseExactPort(selection.port, exclude, probe);
  }
  return selection.preferred === undefined
    ? probe.random(exclude)
    : choosePreferredPort(selection.preferred, exclude, probe);
};

const withPortField = (field: PortField, error: PortAllocationError): PortAllocationError =>
  new PortAllocationError({
    detail: error.detail,
    cause: error.cause,
    field,
    ...(error.port === undefined ? {} : { port: error.port }),
  });

export const allocatePortSet = (
  requests: ReadonlyArray<PortReservationRequest>,
  options: PortAllocationOptions = {},
): Effect.Effect<PortSet, PortAllocationError> =>
  Effect.gen(function* () {
    const reserved = options.reserved ?? new Set<number>();
    const probe = options.probe ?? defaultPortProbe;
    const allocated = new Set<number>();
    const partial: Partial<Record<PortField, number>> = {};

    for (const request of uniqueFields(requests)) {
      const exclude = new Set([...reserved, ...allocated]);
      const port = yield* resolveSelection(request.selection, exclude, probe).pipe(
        Effect.mapError((error) => withPortField(request.field, error)),
      );
      allocated.add(port);
      partial[request.field] = port;
    }

    return Schema.decodeUnknownSync(PortSetSchema)(partial);
  });

export const reservePortSet = (
  requests: ReadonlyArray<PortReservationRequest>,
  options: PortAllocationOptions = {},
): Effect.Effect<PortLease, PortAllocationError> =>
  Effect.suspend(() => {
    const reservations = new Map<PortField, Server>();
    const reserve = Effect.gen(function* () {
      const reserved = options.reserved ?? new Set<number>();
      const allocated = new Set<number>();
      const partial: Partial<Record<PortField, number>> = {};

      const bindAndRegister = (
        field: PortField,
        acquisition: Effect.Effect<BoundPort, PortAllocationError>,
      ) =>
        Effect.uninterruptibleMask(() =>
          Effect.gen(function* () {
            const result = yield* acquisition.pipe(
              Effect.mapError((error) => withPortField(field, error)),
            );
            reservations.set(field, result.server);
            yield* options.onBound?.(field, result) ?? Effect.void;
            return result;
          }),
        );

      for (const request of uniqueFields(requests)) {
        const exclude = new Set([...reserved, ...allocated]);
        const selection = request.selection;
        let bound: BoundPort;

        if (selection.kind === "exact") {
          if (exclude.has(selection.port)) {
            return yield* new PortAllocationError({
              detail: `Port ${selection.port} is not available`,
              field: request.field,
              port: selection.port,
            });
          }
          bound = yield* bindAndRegister(request.field, bindPort(selection.port));
        } else if (selection.preferred !== undefined && !exclude.has(selection.preferred)) {
          bound = yield* bindAndRegister(
            request.field,
            bindPort(selection.preferred).pipe(
              Effect.catchTag("PortAllocationError", () => reserveRandomPort(exclude)),
            ),
          );
        } else {
          bound = yield* bindAndRegister(request.field, reserveRandomPort(exclude));
        }

        allocated.add(bound.port);
        partial[request.field] = bound.port;
      }

      return makePortLease(Schema.decodeUnknownSync(PortSetSchema)(partial), reservations);
    });

    return reserve.pipe(
      Effect.onError(() => releaseReservations(reservations, [...reservations.keys()])),
    );
  });
