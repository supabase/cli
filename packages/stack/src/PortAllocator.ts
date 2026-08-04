import { createServer, type Server } from "node:net";
import { Data, Effect, Schema, Semaphore } from "effect";

export const DEFAULT_API_PORT = 54321;
export const DEFAULT_DB_PORT = 54322;
const DEFAULT_STUDIO_PORT = 54323;
const DEFAULT_MAILPIT_PORT = 54324;
const DEFAULT_MAILPIT_SMTP_PORT = 54325;
const DEFAULT_MAILPIT_POP3_PORT = 54326;
const DEFAULT_ANALYTICS_PORT = 54327;
const DEFAULT_POOLER_PORT = 54329;
const DEFAULT_EDGE_RUNTIME_PORT = 54341;
const DEFAULT_EDGE_RUNTIME_INSPECTOR_PORT = 54342;

export class PortAllocationError extends Data.TaggedError("PortAllocationError")<{
  readonly detail: string;
  readonly cause?: unknown;
}> {}

export interface PortInput {
  readonly apiPort?: number;
  readonly dbPort?: number;
  readonly authPort?: number;
  readonly postgrestPort?: number;
  readonly postgrestAdminPort?: number;
  readonly edgeRuntimePort?: number;
  readonly edgeRuntimeInspectorPort?: number;
  readonly realtimePort?: number;
  readonly storagePort?: number;
  readonly imgproxyPort?: number;
  readonly mailpitPort?: number;
  readonly mailpitSmtpPort?: number;
  readonly mailpitPop3Port?: number;
  readonly pgmetaPort?: number;
  readonly studioPort?: number;
  readonly analyticsPort?: number;
  readonly poolerPort?: number;
  readonly poolerApiPort?: number;
}

export interface AllocatedPorts {
  readonly apiPort: number;
  readonly dbPort: number;
  readonly authPort: number;
  readonly postgrestPort: number;
  readonly postgrestAdminPort: number;
  readonly edgeRuntimePort: number;
  readonly edgeRuntimeInspectorPort: number;
  readonly realtimePort: number;
  readonly storagePort: number;
  readonly imgproxyPort: number;
  readonly mailpitPort: number;
  readonly mailpitSmtpPort: number;
  readonly mailpitPop3Port: number;
  readonly pgmetaPort: number;
  readonly studioPort: number;
  readonly analyticsPort: number;
  readonly poolerPort: number;
  readonly poolerApiPort: number;
}

export const AllocatedPortsSchema = Schema.Struct({
  apiPort: Schema.Number,
  dbPort: Schema.Number,
  authPort: Schema.Number,
  postgrestPort: Schema.Number,
  postgrestAdminPort: Schema.Number,
  edgeRuntimePort: Schema.Number,
  edgeRuntimeInspectorPort: Schema.Number,
  realtimePort: Schema.Number,
  storagePort: Schema.Number,
  imgproxyPort: Schema.Number,
  mailpitPort: Schema.Number,
  mailpitSmtpPort: Schema.Number,
  mailpitPop3Port: Schema.Number,
  pgmetaPort: Schema.Number,
  studioPort: Schema.Number,
  analyticsPort: Schema.Number,
  poolerPort: Schema.Number,
  poolerApiPort: Schema.Number,
});

export const PORT_FIELDS = [
  "apiPort",
  "dbPort",
  "authPort",
  "postgrestPort",
  "postgrestAdminPort",
  "edgeRuntimePort",
  "edgeRuntimeInspectorPort",
  "realtimePort",
  "storagePort",
  "imgproxyPort",
  "mailpitPort",
  "mailpitSmtpPort",
  "mailpitPop3Port",
  "pgmetaPort",
  "studioPort",
  "analyticsPort",
  "poolerPort",
  "poolerApiPort",
] as const satisfies ReadonlyArray<keyof AllocatedPorts>;

export type PortField = (typeof PORT_FIELDS)[number];

export const DEFAULT_PORTS: Partial<AllocatedPorts> = {
  apiPort: DEFAULT_API_PORT,
  dbPort: DEFAULT_DB_PORT,
  studioPort: DEFAULT_STUDIO_PORT,
  mailpitPort: DEFAULT_MAILPIT_PORT,
  mailpitSmtpPort: DEFAULT_MAILPIT_SMTP_PORT,
  mailpitPop3Port: DEFAULT_MAILPIT_POP3_PORT,
  analyticsPort: DEFAULT_ANALYTICS_PORT,
  poolerPort: DEFAULT_POOLER_PORT,
  edgeRuntimePort: DEFAULT_EDGE_RUNTIME_PORT,
  edgeRuntimeInspectorPort: DEFAULT_EDGE_RUNTIME_INSPECTOR_PORT,
};

export interface PortSelectionOptions {
  readonly reserved?: ReadonlySet<number>;
  readonly preferred?: Partial<AllocatedPorts>;
}

interface PortAllocationOptions extends PortSelectionOptions {
  readonly probe?: PortProbe;
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
        const addr = server.address();
        const port = typeof addr === "object" && addr !== null ? addr.port : 0;
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
      resume(Effect.fail(new PortAllocationError({ detail: `Port ${port} is not available` }))),
    );
    return Effect.void;
  });

const chooseExactPort = (
  port: number,
  exclude: ReadonlySet<number>,
  probe: PortProbe,
): Effect.Effect<number, PortAllocationError> =>
  exclude.has(port)
    ? Effect.fail(new PortAllocationError({ detail: `Port ${port} is not available` }))
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
  readonly ports: AllocatedPorts;
  readonly reserve: (fields: ReadonlyArray<PortField>) => Effect.Effect<void, PortAllocationError>;
  readonly release: (fields: ReadonlyArray<PortField>) => Effect.Effect<void>;
  readonly releaseAll: Effect.Effect<void>;
}

const releaseReservations = (
  reservations: Map<PortField, Server>,
  fields: ReadonlyArray<PortField>,
) =>
  Effect.forEach(
    fields,
    (field) => {
      const server = reservations.get(field);
      if (server === undefined) {
        return Effect.void;
      }
      reservations.delete(field);
      return closeServer(server);
    },
    { discard: true },
  );

const reserveReservations = (
  ports: AllocatedPorts,
  reservations: Map<PortField, Server>,
  fields: ReadonlyArray<PortField>,
): Effect.Effect<void, PortAllocationError> =>
  Effect.suspend(() => {
    const acquired: Array<PortField> = [];
    return Effect.forEach(
      fields,
      (field) => {
        if (reservations.has(field)) return Effect.void;
        return Effect.tap(bindPort(ports[field]), ({ server }) =>
          Effect.sync(() => {
            reservations.set(field, server);
            acquired.push(field);
          }),
        );
      },
      { discard: true },
    ).pipe(Effect.onError(() => releaseReservations(reservations, acquired)));
  });

const makePortLease = (ports: AllocatedPorts, reservations: Map<PortField, Server>): PortLease => {
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

/**
 * Allocate and keep every selected TCP port bound until its lease is released.
 * This closes the probe-then-bind race for lazily started services.
 */
export const reservePorts = (
  input: PortInput,
  options: PortSelectionOptions = {},
): Effect.Effect<PortLease, PortAllocationError> =>
  Effect.suspend(() => {
    const reservations = new Map<PortField, Server>();
    const reserve = Effect.gen(function* () {
      const reserved = options.reserved ?? new Set<number>();
      const preferred = options.preferred ?? {};
      const allocated = new Set<number>();
      const partial: Partial<Record<PortField, number>> = {};

      for (const field of PORT_FIELDS) {
        const exclude = new Set([...reserved, ...allocated]);
        const explicit = input[field];
        const preferredPort = preferred[field];
        let bound: BoundPort;

        if (explicit !== undefined) {
          if (exclude.has(explicit)) {
            return yield* new PortAllocationError({ detail: `Port ${explicit} is not available` });
          }
          bound = yield* bindPort(explicit);
        } else if (preferredPort !== undefined && !exclude.has(preferredPort)) {
          bound = yield* bindPort(preferredPort).pipe(
            Effect.catchTag("PortAllocationError", () => reserveRandomPort(exclude)),
          );
        } else {
          bound = yield* reserveRandomPort(exclude);
        }

        allocated.add(bound.port);
        reservations.set(field, bound.server);
        partial[field] = bound.port;
      }

      return makePortLease(Schema.decodeUnknownSync(AllocatedPortsSchema)(partial), reservations);
    });

    return reserve.pipe(
      Effect.onError(() => releaseReservations(reservations, [...reservations.keys()])),
    );
  });

/** Reserve an already-resolved subset of ports, typically in a daemon process. */
export const reserveAllocatedPorts = (
  ports: AllocatedPorts,
  fields: ReadonlyArray<PortField>,
): Effect.Effect<PortLease, PortAllocationError> =>
  Effect.suspend(() => {
    const reservations = new Map<PortField, Server>();
    const reserve = Effect.forEach(
      fields,
      (field) =>
        Effect.tap(bindPort(ports[field]), ({ server }) =>
          Effect.sync(() => {
            reservations.set(field, server);
          }),
        ),
      { discard: true },
    ).pipe(Effect.as(makePortLease(ports, reservations)));

    return reserve.pipe(
      Effect.onError(() => releaseReservations(reservations, [...reservations.keys()])),
    );
  });

export const allocatePorts = (
  input: PortInput,
  options: PortAllocationOptions = {},
): Effect.Effect<AllocatedPorts, PortAllocationError> =>
  Effect.gen(function* () {
    const reserved = options.reserved ?? new Set<number>();
    const preferred = options.preferred ?? {};
    const probe = options.probe ?? defaultPortProbe;
    const allocated = new Set<number>();

    const alloc = (port: number) => {
      allocated.add(port);
      return port;
    };

    const exclude = () => new Set([...reserved, ...allocated]);

    const resolvePort = (field: PortField) => {
      const explicit = input[field];
      if (explicit !== undefined) {
        return chooseExactPort(explicit, exclude(), probe);
      }

      const preferredPort = preferred[field];
      if (preferredPort !== undefined) {
        return choosePreferredPort(preferredPort, exclude(), probe);
      }

      return probe.random(exclude());
    };

    const partial: Partial<Record<PortField, number>> = {};
    for (const field of PORT_FIELDS) {
      partial[field] = alloc(yield* resolvePort(field));
    }

    return Schema.decodeUnknownSync(AllocatedPortsSchema)(partial);
  });
