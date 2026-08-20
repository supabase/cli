import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Cause, Data, Effect, FileSystem, Option, Schema, Semaphore } from "effect";
import type { PlatformError } from "effect/PlatformError";
import { PortSetSchema, type PortField, type PortSet } from "./PortCatalog.ts";

export class PortAllocationError extends Data.TaggedError("PortAllocationError")<{
  readonly detail: string;
  readonly cause?: unknown;
  readonly field?: PortField;
  readonly port?: number;
  readonly reason?: "unavailable" | "failed";
}> {
  override get message(): string {
    return this.detail;
  }
}

class PortClaimCollisionError extends Data.TaggedError("PortClaimCollisionError")<{
  readonly port: number;
}> {}

const MAX_CLAIM_ATTEMPTS = 32;
const MAX_RANDOM_PORT_ATTEMPTS = 64;

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
  attempt = 0,
): Effect.Effect<number, PortAllocationError> => {
  if (attempt >= MAX_RANDOM_PORT_ATTEMPTS) {
    return Effect.fail(new PortAllocationError({ detail: "No random ports available" }));
  }
  return Effect.flatMap(
    Effect.callback<number, PortAllocationError>((resume) => {
      const server = createServer();
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        const port = typeof address === "object" && address !== null ? address.port : 0;
        resume(closeServer(server).pipe(Effect.andThen(Effect.succeed(port))));
      });
      server.on("error", (cause) =>
        resume(
          Effect.fail(new PortAllocationError({ detail: "Failed to bind random port", cause })),
        ),
      );
      return closeServer(server);
    }),
    (port) => (exclude.has(port) ? probeRandomPort(exclude, attempt + 1) : Effect.succeed(port)),
  );
};

/** Probe the exact port requested by the user. Fail if it is not available. */
const probeExactPort = (port: number): Effect.Effect<number, PortAllocationError> =>
  Effect.callback<number, PortAllocationError>((resume) => {
    const server = createServer();
    server.listen(port, "127.0.0.1", () => {
      resume(closeServer(server).pipe(Effect.andThen(Effect.succeed(port))));
    });
    server.on("error", (cause) =>
      resume(
        Effect.fail(
          new PortAllocationError({
            detail: `Port ${port} is not available`,
            port,
            reason: "unavailable",
            cause,
          }),
        ),
      ),
    );
    return closeServer(server);
  });

const chooseExactPort = (
  port: number,
  exclude: ReadonlySet<number>,
  probe: PortProbe,
): Effect.Effect<number, PortAllocationError> => {
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    return Effect.fail(new PortAllocationError({ detail: `Invalid exact port ${port}`, port }));
  }
  return exclude.has(port)
    ? Effect.fail(
        new PortAllocationError({
          detail: `Port ${port} is not available`,
          port,
          reason: "unavailable",
        }),
      )
    : probe.exact(port);
};

const choosePreferredPort = (
  port: number,
  exclude: ReadonlySet<number>,
  probe: PortProbe,
): Effect.Effect<number, PortAllocationError> =>
  port <= 0 || exclude.has(port)
    ? probe.random(exclude)
    : probe
        .exact(port)
        .pipe(
          Effect.catchTag("PortAllocationError", (error) =>
            error.reason === "unavailable" ? probe.random(exclude) : Effect.fail(error),
          ),
        );

const defaultPortProbe: PortProbe = {
  exact: probeExactPort,
  random: probeRandomPort,
};

const closeServer = (server: Server): Effect.Effect<void> =>
  Effect.callback<void>((resume) => {
    if (!server.listening) {
      resume(Effect.void);
      return Effect.void;
    }
    server.close((cause) => resume(cause === undefined ? Effect.void : Effect.die(cause)));
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

const staleClaimPath = (path: string): string => `${path}.stale-${process.pid}-${randomUUID()}`;

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

const isNotFound = (error: PlatformError): boolean => error.reason._tag === "NotFound";
const isAlreadyExists = (error: PlatformError): boolean => error.reason._tag === "AlreadyExists";

const readClaimRecord = (
  path: string,
): Effect.Effect<ClaimRecord | undefined, PlatformError, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const contents = yield* fs
      .readFileString(path)
      .pipe(
        Effect.catchTag("PlatformError", (error) =>
          isNotFound(error) ? Effect.succeed(undefined) : Effect.fail(error),
        ),
      );
    if (contents === undefined) return undefined;
    try {
      const value: unknown = JSON.parse(contents);
      if (typeof value !== "object" || value === null) return undefined;
      const pid = Reflect.get(value, "pid");
      const token = Reflect.get(value, "token");
      return typeof pid === "number" &&
        Number.isInteger(pid) &&
        pid > 0 &&
        typeof token === "string"
        ? { pid, token }
        : undefined;
    } catch {
      return undefined;
    }
  });

const claimIsStale = (path: string): Effect.Effect<boolean, PlatformError, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const record = yield* readClaimRecord(path);
    if (record !== undefined) return !isProcessAlive(record.pid);
    const info = yield* fs
      .stat(path)
      .pipe(
        Effect.catchTag("PlatformError", (error) =>
          isNotFound(error) ? Effect.succeed(undefined) : Effect.fail(error),
        ),
      );
    return (
      info === undefined ||
      Date.now() - Option.getOrElse(info.mtime, () => new Date()).getTime() > CLAIM_STALE_AFTER_MS
    );
  });

const quarantineClaim = (
  path: string,
): Effect.Effect<boolean, PlatformError, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const quarantine = staleClaimPath(path);
    const renamed = yield* fs
      .rename(path, quarantine)
      .pipe(
        Effect.catchTag("PlatformError", (error) =>
          isNotFound(error) ? Effect.succeed(false) : Effect.fail(error),
        ),
      );
    if (!renamed) return false;
    yield* fs.remove(quarantine, { force: true });
    return true;
  });

const acquirePortClaimInternal = (
  port: number,
): Effect.Effect<
  PortClaim,
  PlatformError | PortAllocationError | PortClaimCollisionError,
  FileSystem.FileSystem
> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    yield* fs.makeDirectory(CLAIM_ROOT, { recursive: true });
    const path = claimPath(port);
    const token = randomUUID();
    const contents = JSON.stringify({ pid: process.pid, token });

    for (let attempt = 0; attempt < MAX_CLAIM_ATTEMPTS; attempt += 1) {
      const opened = yield* Effect.exit(
        Effect.scoped(
          fs
            .open(path, { flag: "wx", mode: 0o600 })
            .pipe(Effect.flatMap((handle) => handle.writeAll(new TextEncoder().encode(contents)))),
        ),
      );
      if (opened._tag === "Success") return { path, port, token };
      const failure = Cause.findErrorOption(opened.cause);
      if (Option.isNone(failure)) return yield* Effect.failCause(opened.cause);
      if (!isAlreadyExists(failure.value)) {
        return yield* Effect.fail(failure.value);
      }
      if (!(yield* claimIsStale(path))) {
        return yield* new PortClaimCollisionError({ port });
      }
      if (!(yield* quarantineClaim(path))) continue;
    }
    return yield* new PortAllocationError({
      detail: `Failed to claim port ${port} after ${MAX_CLAIM_ATTEMPTS} attempts`,
      port,
      reason: "failed",
    });
  });

const portAllocationFromCause = (port: number, cause: unknown): PortAllocationError =>
  cause instanceof PortAllocationError
    ? cause
    : new PortAllocationError({
        detail: `Failed to claim port ${port}`,
        cause,
        port,
        reason: "failed",
      });

const acquirePortClaim = (
  port: number,
): Effect.Effect<PortClaim, PortAllocationError | PortClaimCollisionError, FileSystem.FileSystem> =>
  acquirePortClaimInternal(port).pipe(
    Effect.mapError((cause) =>
      cause instanceof PortClaimCollisionError ? cause : portAllocationFromCause(port, cause),
    ),
  );

const releasePortClaim = (claim: PortClaim, fs: FileSystem.FileSystem): Effect.Effect<void> =>
  Effect.gen(function* () {
    const record = yield* readClaimRecord(claim.path).pipe(
      Effect.orElseSucceed(() => undefined),
      Effect.provideService(FileSystem.FileSystem, fs),
    );
    if (record?.token !== claim.token || record.pid !== process.pid) return;
    yield* fs.remove(claim.path, { force: true }).pipe(Effect.ignore);
  });

const claimedPorts = (): Effect.Effect<
  ReadonlySet<number>,
  PortAllocationError,
  FileSystem.FileSystem
> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const entries = yield* fs
      .readDirectory(CLAIM_ROOT)
      .pipe(
        Effect.catchTag("PlatformError", (error) =>
          isNotFound(error) ? Effect.succeed([]) : Effect.fail(error),
        ),
      );
    const ports = new Set<number>();
    for (const entry of entries) {
      if (!entry.startsWith("port-")) continue;
      const port = Number(entry.slice("port-".length));
      if (!Number.isInteger(port) || port <= 0 || port > 65_535) continue;
      const path = join(CLAIM_ROOT, entry);
      const info = yield* fs
        .stat(path)
        .pipe(
          Effect.catchTag("PlatformError", (error) =>
            isNotFound(error) ? Effect.succeed(undefined) : Effect.fail(error),
          ),
        );
      if (info === undefined || info.type !== "File") continue;
      while (yield* claimIsStale(path)) {
        if (yield* quarantineClaim(path)) break;
        const exists = yield* fs.stat(path).pipe(
          Effect.as(true),
          Effect.catchTag("PlatformError", (error) =>
            isNotFound(error) ? Effect.succeed(false) : Effect.fail(error),
          ),
        );
        if (!exists) break;
      }
      if (!(yield* claimIsStale(path))) ports.add(port);
    }
    return ports;
  }).pipe(
    Effect.mapError((cause) =>
      cause instanceof PortAllocationError
        ? cause
        : new PortAllocationError({
            detail: "Failed to inspect port claims",
            cause,
            reason: "failed",
          }),
    ),
  );

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
            reason: port === 0 ? "failed" : "unavailable",
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
  fs: FileSystem.FileSystem,
): Effect.Effect<void> =>
  Effect.forEach(
    uniquePortFields(fields),
    (field) => {
      const claim = claims.get(field);
      if (claim === undefined) return Effect.void;
      claims.delete(field);
      return releasePortClaim(claim, fs);
    },
    { discard: true },
  );

const claimAndBind = (
  field: PortField,
  port: number,
  claims: Map<PortField, PortClaim>,
  fs: FileSystem.FileSystem,
): Effect.Effect<BoundPort, PortAllocationError | PortClaimCollisionError> => {
  const existingClaim = claims.get(field);
  return (
    existingClaim === undefined
      ? acquirePortClaim(port).pipe(Effect.provideService(FileSystem.FileSystem, fs))
      : Effect.succeed(existingClaim)
  ).pipe(
    Effect.flatMap((claim) =>
      bindPort(port).pipe(
        Effect.onError(() =>
          existingClaim === undefined ? releasePortClaim(claim, fs) : Effect.void,
        ),
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
  fs: FileSystem.FileSystem,
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
        return claimAndBind(field, port, claims, fs).pipe(
          Effect.mapError((error) =>
            error instanceof PortClaimCollisionError
              ? new PortAllocationError({
                  detail: `Port ${error.port} is not available`,
                  field,
                  port: error.port,
                  reason: "unavailable",
                })
              : withPortField(field, error),
          ),
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
          [releaseReservations(reservations, acquired), releaseClaims(claims, acquiredClaims, fs)],
          { discard: true },
        ),
      ),
    );
  });

const makePortLease = (
  ports: PortSet,
  reservations: Map<PortField, Server>,
  claims: Map<PortField, PortClaim>,
  fs: FileSystem.FileSystem,
): PortLease => {
  const lock = Semaphore.makeUnsafe(1);
  return {
    ports,
    reserve: (fields) =>
      lock.withPermit(reserveReservations(ports, reservations, claims, fields, fs)),
    release: (fields) => lock.withPermit(releaseReservations(reservations, fields)),
    releaseAll: lock.withPermit(
      Effect.suspend(() =>
        Effect.all(
          [
            releaseReservations(reservations, [...reservations.keys()]),
            releaseClaims(claims, [...claims.keys()], fs),
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
  fs: FileSystem.FileSystem,
  attempt = 0,
): Effect.Effect<
  BoundPort,
  PortAllocationError | PortClaimCollisionError,
  FileSystem.FileSystem
> => {
  if (attempt >= MAX_CLAIM_ATTEMPTS) {
    return Effect.fail(
      new PortAllocationError({
        detail: `Failed to reserve a random port after ${MAX_CLAIM_ATTEMPTS} claim collisions`,
        reason: "failed",
      }),
    );
  }
  return Effect.flatMap(bindPort(0), (bound) =>
    exclude.has(bound.port)
      ? closeServer(bound.server).pipe(
          Effect.andThen(reserveRandomPort(exclude, field, claims, fs, attempt + 1)),
        )
      : acquirePortClaimInternal(bound.port).pipe(
          Effect.provideService(FileSystem.FileSystem, fs),
          Effect.tap((claim) => Effect.sync(() => claims.set(field, claim))),
          Effect.map(() => bound),
          Effect.catchTag("PortClaimCollisionError", () =>
            closeServer(bound.server).pipe(
              Effect.andThen(reserveRandomPort(exclude, field, claims, fs, attempt + 1)),
            ),
          ),
          Effect.catchTag("PlatformError", (cause) =>
            closeServer(bound.server).pipe(
              Effect.andThen(Effect.fail(portAllocationFromCause(bound.port, cause))),
            ),
          ),
          Effect.catchTag("PortAllocationError", (error) =>
            closeServer(bound.server).pipe(Effect.andThen(Effect.fail(error))),
          ),
        ),
  );
};

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
    reason: error.reason,
    ...(error.port === undefined ? {} : { port: error.port }),
  });

export const allocatePortSet = (
  requests: ReadonlyArray<PortReservationRequest>,
  options: PortAllocationOptions = {},
): Effect.Effect<PortSet, PortAllocationError, FileSystem.FileSystem> =>
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
): Effect.Effect<PortLease, PortAllocationError, FileSystem.FileSystem> =>
  Effect.suspend(() => {
    const reservations = new Map<PortField, Server>();
    const claims = new Map<PortField, PortClaim>();
    const reserve = (fs: FileSystem.FileSystem) =>
      Effect.gen(function* () {
        const reserved = options.reserved ?? new Set<number>();
        const allocated = new Set<number>();
        const partial: Partial<Record<PortField, number>> = {};

        const bindAndRegister = (
          field: PortField,
          acquisition: Effect.Effect<BoundPort, PortAllocationError | PortClaimCollisionError>,
        ) =>
          Effect.uninterruptibleMask((restore) =>
            Effect.gen(function* () {
              const result = yield* restore(
                acquisition.pipe(
                  Effect.mapError((error) =>
                    error instanceof PortClaimCollisionError
                      ? new PortAllocationError({
                          detail: `Port ${error.port} is not available`,
                          field,
                          port: error.port,
                          reason: "unavailable",
                        })
                      : withPortField(field, error),
                  ),
                ),
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
            if (
              !Number.isInteger(selection.port) ||
              selection.port < 1 ||
              selection.port > 65_535
            ) {
              return yield* new PortAllocationError({
                detail: `Invalid exact port ${selection.port}`,
                field: request.field,
                port: selection.port,
              });
            }
            if (exclude.has(selection.port)) {
              return yield* new PortAllocationError({
                detail: `Port ${selection.port} is not available`,
                field: request.field,
                port: selection.port,
              });
            }
            bound = yield* bindAndRegister(
              request.field,
              claimAndBind(request.field, selection.port, claims, fs),
            );
          } else if (
            selection.preferred !== undefined &&
            selection.preferred > 0 &&
            !exclude.has(selection.preferred)
          ) {
            const preferred = selection.preferred;
            bound = yield* bindAndRegister(
              request.field,
              claimAndBind(request.field, preferred, claims, fs).pipe(
                Effect.catchTag("PortClaimCollisionError", () =>
                  reserveRandomPort(exclude, request.field, claims, fs).pipe(
                    Effect.provideService(FileSystem.FileSystem, fs),
                  ),
                ),
                Effect.catchTag("PortAllocationError", (error) =>
                  error.reason === "unavailable"
                    ? reserveRandomPort(exclude, request.field, claims, fs).pipe(
                        Effect.provideService(FileSystem.FileSystem, fs),
                      )
                    : Effect.fail(error),
                ),
              ),
            );
          } else {
            bound = yield* bindAndRegister(
              request.field,
              reserveRandomPort(exclude, request.field, claims, fs).pipe(
                Effect.provideService(FileSystem.FileSystem, fs),
              ),
            );
          }

          allocated.add(bound.port);
          partial[request.field] = bound.port;
        }

        return makePortLease(
          Schema.decodeUnknownSync(PortSetSchema)(partial),
          reservations,
          claims,
          fs,
        );
      });

    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      return yield* reserve(fs).pipe(
        Effect.onError(() =>
          Effect.all(
            [
              releaseReservations(reservations, [...reservations.keys()]),
              releaseClaims(claims, [...claims.keys()], fs),
            ],
            { discard: true },
          ),
        ),
      );
    });
  });
