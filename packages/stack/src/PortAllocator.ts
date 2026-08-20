import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, readdir, rm, stat } from "node:fs/promises";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

interface PortClaim {
  readonly path: string;
  readonly port: number;
  readonly token: string;
}

interface ClaimRecord {
  readonly pid: number;
  readonly token: string;
}

const claimNamespace = (): string => {
  const uid = process.getuid?.();
  if (uid !== undefined) return `uid-${uid}`;
  const username = process.env.USER ?? process.env.USERNAME ?? "unknown";
  const safeUsername = username.replace(/[^a-zA-Z0-9._-]/g, "_") || "unknown";
  return `user-${safeUsername}`;
};

const CLAIM_ROOT = join(tmpdir(), `supabase-stack-port-claims-${claimNamespace()}`);
const CLAIM_STALE_AFTER_MS = 30_000;

const claimPath = (port: number): string => join(CLAIM_ROOT, `port-${port}`);

const isProcessAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (cause) {
    return typeof cause === "object" && cause !== null && "code" in cause
      ? Reflect.get(cause, "code") !== "ESRCH"
      : false;
  }
};

const readClaimRecord = async (path: string): Promise<ClaimRecord | undefined> => {
  let contents: string;
  try {
    contents = await readFile(path, "utf8");
  } catch (cause) {
    if (typeof cause === "object" && cause !== null && "code" in cause) {
      if (Reflect.get(cause, "code") === "ENOENT") return undefined;
    }
    throw cause;
  }
  try {
    const value: unknown = JSON.parse(contents);
    if (typeof value !== "object" || value === null) return undefined;
    const pid = Reflect.get(value, "pid");
    const token = Reflect.get(value, "token");
    return typeof pid === "number" && Number.isInteger(pid) && pid > 0 && typeof token === "string"
      ? { pid, token }
      : undefined;
  } catch {
    return undefined;
  }
};

const claimIsStale = async (path: string): Promise<boolean> => {
  const record = await readClaimRecord(path);
  if (record !== undefined) return !isProcessAlive(record.pid);
  try {
    const info = await stat(path);
    return Date.now() - info.mtimeMs > CLAIM_STALE_AFTER_MS;
  } catch (cause) {
    if (typeof cause === "object" && cause !== null && "code" in cause) {
      if (Reflect.get(cause, "code") === "ENOENT") return true;
    }
    throw cause;
  }
};

const acquirePortClaim = (port: number): Effect.Effect<PortClaim, PortAllocationError> =>
  Effect.tryPromise({
    try: async () => {
      await mkdir(CLAIM_ROOT, { recursive: true });
      const path = claimPath(port);
      const token = randomUUID();
      const contents = JSON.stringify({ pid: process.pid, token });

      while (true) {
        try {
          const handle = await open(path, "wx");
          try {
            await handle.writeFile(contents, "utf8");
          } finally {
            await handle.close();
          }
          return { path, port, token };
        } catch (cause) {
          if (
            typeof cause !== "object" ||
            cause === null ||
            !("code" in cause) ||
            Reflect.get(cause, "code") !== "EEXIST"
          ) {
            throw cause;
          }
          if (!(await claimIsStale(path))) {
            throw new PortAllocationError({ detail: `Port ${port} is not available`, port });
          }
          await rm(path, { force: true });
        }
      }
    },
    catch: (cause) =>
      cause instanceof PortAllocationError
        ? cause
        : new PortAllocationError({ detail: `Failed to claim port ${port}`, cause, port }),
  });

const releasePortClaim = (claim: PortClaim): Effect.Effect<void> =>
  Effect.tryPromise({
    try: async () => {
      const record = await readClaimRecord(claim.path);
      if (record?.token !== claim.token || record.pid !== process.pid) return;
      await rm(claim.path, { force: true });
    },
    catch: () => undefined,
  }).pipe(
    Effect.catch(() => Effect.void),
    Effect.asVoid,
  );

const claimedPorts = (): Effect.Effect<ReadonlySet<number>> =>
  Effect.tryPromise({
    try: async () => {
      const entries = await readdir(CLAIM_ROOT, { withFileTypes: true }).catch((cause) => {
        if (typeof cause === "object" && cause !== null && "code" in cause) {
          if (Reflect.get(cause, "code") === "ENOENT") return [];
        }
        throw cause;
      });
      const ports = new Set<number>();
      for (const entry of entries) {
        if (!entry.isFile() || !entry.name.startsWith("port-")) continue;
        const port = Number(entry.name.slice("port-".length));
        if (!Number.isInteger(port) || port <= 0 || port > 65_535) continue;
        if (await claimIsStale(join(CLAIM_ROOT, entry.name))) {
          await rm(join(CLAIM_ROOT, entry.name), { force: true });
          continue;
        }
        ports.add(port);
      }
      return ports;
    },
    catch: () => new Set<number>(),
  }).pipe(Effect.catch(() => Effect.succeed(new Set<number>())));

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
  /** Releases TCP reservations while retaining ownership claims for this lease. */
  readonly release: (fields: ReadonlyArray<PortField>) => Effect.Effect<void>;
  /** Releases all TCP reservations and ends ownership of every selected port. */
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

const releaseClaims = (
  claims: Map<PortField, PortClaim>,
  fields: ReadonlyArray<PortField>,
): Effect.Effect<void> =>
  Effect.forEach(
    uniquePortFields(fields),
    (field) => {
      const claim = claims.get(field);
      if (claim === undefined) return Effect.void;
      claims.delete(field);
      return releasePortClaim(claim);
    },
    { discard: true },
  );

const claimAndBind = (
  field: PortField,
  port: number,
  claims: Map<PortField, PortClaim>,
): Effect.Effect<BoundPort, PortAllocationError> => {
  const existingClaim = claims.get(field);
  return (
    existingClaim === undefined ? acquirePortClaim(port) : Effect.succeed(existingClaim)
  ).pipe(
    Effect.flatMap((claim) =>
      bindPort(port).pipe(
        Effect.onError(() => (existingClaim === undefined ? releasePortClaim(claim) : Effect.void)),
        Effect.tap(({ server }) =>
          Effect.sync(() => {
            claims.set(field, claim);
            return server;
          }),
        ),
      ),
    ),
  );
};

const reserveReservations = (
  ports: PortSet,
  reservations: Map<PortField, Server>,
  claims: Map<PortField, PortClaim>,
  fields: ReadonlyArray<PortField>,
): Effect.Effect<void, PortAllocationError> =>
  Effect.suspend(() => {
    const acquired: Array<PortField> = [];
    const acquiredClaims: Array<PortField> = [];
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
        const existingClaim = claims.has(field);
        return claimAndBind(field, port, claims).pipe(
          Effect.mapError((error) => withPortField(field, error)),
          Effect.tap(({ server }) =>
            Effect.sync(() => {
              reservations.set(field, server);
              acquired.push(field);
              if (!existingClaim) acquiredClaims.push(field);
            }),
          ),
        );
      },
      { discard: true },
    ).pipe(
      Effect.onError(() =>
        Effect.all(
          [releaseReservations(reservations, acquired), releaseClaims(claims, acquiredClaims)],
          { discard: true },
        ),
      ),
    );
  });

const makePortLease = (
  ports: PortSet,
  reservations: Map<PortField, Server>,
  claims: Map<PortField, PortClaim>,
): PortLease => {
  const lock = Semaphore.makeUnsafe(1);
  return {
    ports,
    reserve: (fields) => lock.withPermit(reserveReservations(ports, reservations, claims, fields)),
    release: (fields) => lock.withPermit(releaseReservations(reservations, fields)),
    releaseAll: lock.withPermit(
      Effect.suspend(() =>
        Effect.all(
          [
            releaseReservations(reservations, [...reservations.keys()]),
            releaseClaims(claims, [...claims.keys()]),
          ],
          { discard: true },
        ),
      ),
    ),
  };
};

const reserveRandomPort = (
  exclude: ReadonlySet<number>,
  field: PortField,
  claims: Map<PortField, PortClaim>,
): Effect.Effect<BoundPort, PortAllocationError> =>
  Effect.flatMap(bindPort(0), (bound) =>
    exclude.has(bound.port)
      ? closeServer(bound.server).pipe(Effect.andThen(reserveRandomPort(exclude, field, claims)))
      : acquirePortClaim(bound.port).pipe(
          Effect.tap((claim) => Effect.sync(() => claims.set(field, claim))),
          Effect.map(() => bound),
          Effect.catchTag("PortAllocationError", () =>
            closeServer(bound.server).pipe(
              Effect.andThen(reserveRandomPort(exclude, field, claims)),
            ),
          ),
        ),
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
    const reserved = new Set([...(options.reserved ?? []), ...(yield* claimedPorts())]);
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
    const claims = new Map<PortField, PortClaim>();
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
          bound = yield* bindAndRegister(
            request.field,
            claimAndBind(request.field, selection.port, claims),
          );
        } else if (selection.preferred !== undefined && !exclude.has(selection.preferred)) {
          const preferred = selection.preferred;
          bound = yield* bindAndRegister(
            request.field,
            claimAndBind(request.field, preferred, claims).pipe(
              Effect.catchTag("PortAllocationError", () =>
                reserveRandomPort(exclude, request.field, claims),
              ),
            ),
          );
        } else {
          bound = yield* bindAndRegister(
            request.field,
            reserveRandomPort(exclude, request.field, claims),
          );
        }

        allocated.add(bound.port);
        partial[request.field] = bound.port;
      }

      return makePortLease(Schema.decodeUnknownSync(PortSetSchema)(partial), reservations, claims);
    });

    return reserve.pipe(
      Effect.onError(() =>
        Effect.all(
          [
            releaseReservations(reservations, [...reservations.keys()]),
            releaseClaims(claims, [...claims.keys()]),
          ],
          { discard: true },
        ),
      ),
    );
  });
