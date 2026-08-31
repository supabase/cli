import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
// oxlint-disable-next-line effecttsgo/node-builtin-import -- Port claim paths are native temporary filesystem boundary values.
import { join } from "node:path";
import {
  Cause,
  Data,
  Effect,
  Exit,
  FileSystem,
  Option,
  Predicate,
  Schema,
  Semaphore,
} from "effect";
import { PlatformError } from "effect/PlatformError";
import { PORT_CATALOG, PortSetSchema, type PortField, type PortSet } from "./PortCatalog.ts";

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

export type PortSelection =
  | { readonly kind: "exact"; readonly port: number }
  | {
      readonly kind: "automatic";
      readonly preferred?: number;
      /** Additional exclusions used by managed allocation (for example control ports). */
      readonly excluded?: ReadonlySet<number>;
    };

export interface PortReservationRequest {
  readonly field: PortField;
  readonly selection: PortSelection;
}

export interface PortSelectionOptions {
  readonly reserved?: ReadonlySet<number>;
}

const closeServer = (server: Server): Effect.Effect<void> =>
  Effect.callback<void>((resume) => {
    server.close((cause) =>
      resume(
        cause === undefined ||
          (typeof cause === "object" &&
            cause !== null &&
            "code" in cause &&
            Reflect.get(cause, "code") === "ERR_SERVER_NOT_RUNNING")
          ? Effect.void
          : Effect.die(cause),
      ),
    );
    return Effect.void;
  });

interface BoundPort {
  readonly port: number;
  readonly server: Server;
}

interface PortAllocation {
  readonly ports: ReadonlyArray<BoundPort>;
  readonly basePort: number;
}

interface PortClaim {
  readonly path: string;
  readonly port: number;
  readonly token: string;
}

const portSpan = (field: PortField): number => PORT_CATALOG[field].span ?? 1;

const portsForField = (field: PortField, basePort: number): ReadonlyArray<number> =>
  Array.from({ length: portSpan(field) }, (_, offset) => basePort + offset);

interface ClaimRecord {
  readonly pid: number;
  readonly token: string;
}

interface ClaimSnapshot {
  readonly contents: string;
  readonly record: ClaimRecord | undefined;
  readonly info: FileSystem.File.Info;
}

const claimNamespace = (): string => {
  const uid = process.getuid?.();
  if (uid !== undefined) return `uid-${uid}`;
  // oxlint-disable-next-line effecttsgo/process-env -- Claim namespace fallback is computed before an Effect runtime exists.
  const username = process.env.USER ?? process.env.USERNAME ?? "unknown";
  const safeUsername = username.replace(/[^a-zA-Z0-9._-]/g, "_") || "unknown";
  return `user-${safeUsername}`;
};

const CLAIM_ROOT = join(tmpdir(), `supabase-stack-port-claims-${claimNamespace()}`);
const CLAIM_STALE_AFTER_MS = 30_000;

const claimPath = (port: number, root = CLAIM_ROOT): string => join(root, `port-${port}`);

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

const isNotFound = (error: PlatformError): boolean => Predicate.isTagged(error.reason, "NotFound");
const isAlreadyExists = (error: PlatformError): boolean =>
  Predicate.isTagged(error.reason, "AlreadyExists");

const parseClaimRecord = (contents: string): ClaimRecord | undefined => {
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

const readClaimSnapshot = (
  path: string,
): Effect.Effect<ClaimSnapshot | undefined, PlatformError, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const contents = yield* fs
      .readFileString(path)
      .pipe(
        Effect.catchTag("PlatformError", (error) =>
          isNotFound(error) ? Effect.void : Effect.fail(error),
        ),
      );
    if (contents === undefined) return undefined;
    const info = yield* fs
      .stat(path)
      .pipe(
        Effect.catchTag("PlatformError", (error) =>
          isNotFound(error) ? Effect.void : Effect.fail(error),
        ),
      );
    if (info === undefined) return undefined;
    return { contents, record: parseClaimRecord(contents), info };
  });

const claimIsStale = (snapshot: ClaimSnapshot, now: number): boolean => {
  if (snapshot.info.type !== "File") return false;
  if (snapshot.record !== undefined) return !isProcessAlive(snapshot.record.pid);
  return (
    Option.isSome(snapshot.info.mtime) &&
    now - snapshot.info.mtime.value.getTime() > CLAIM_STALE_AFTER_MS
  );
};

const inspectClaim = (
  path: string,
): Effect.Effect<
  { readonly snapshot: ClaimSnapshot; readonly stale: boolean } | undefined,
  PlatformError,
  FileSystem.FileSystem
> =>
  Effect.gen(function* () {
    const snapshot = yield* readClaimSnapshot(path);
    if (snapshot === undefined) return undefined;
    // Claim mtimes come from the native filesystem wall clock; compare them
    // against the same wall-clock source rather than Effect's virtual Clock.
    // oxlint-disable-next-line effecttsgo/global-date-in-effect -- Native filesystem mtime staleness requires wall-clock time at this leaf boundary.
    return { snapshot, stale: claimIsStale(snapshot, Date.now()) };
  });

const claimIdentityMatches = (expected: ClaimSnapshot, current: ClaimSnapshot): boolean => {
  if (expected.record !== undefined || current.record !== undefined) {
    return (
      expected.record !== undefined &&
      current.record !== undefined &&
      expected.record.pid === current.record.pid &&
      expected.record.token === current.record.token
    );
  }
  if (expected.contents !== current.contents) return false;
  if (Option.isSome(expected.info.ino) && Option.isSome(current.info.ino)) {
    return expected.info.ino.value === current.info.ino.value;
  }
  return false;
};

const removeCreatedClaim = (
  path: string,
  contents: string,
  openedInfo: FileSystem.File.Info | undefined,
  opened: boolean,
  fs: FileSystem.FileSystem,
): Effect.Effect<void> =>
  Effect.gen(function* () {
    if (!opened) return;
    const current = yield* readClaimSnapshot(path).pipe(Effect.orElseSucceed(() => undefined));
    if (current === undefined) return;
    if (openedInfo === undefined) {
      if (current.contents.length !== 0) return;
    } else if (Option.isSome(openedInfo.ino) && Option.isSome(current.info.ino)) {
      if (openedInfo.ino.value !== current.info.ino.value) return;
    } else {
      if (current.contents !== contents) return;
      if (
        !Option.isSome(openedInfo.mtime) ||
        !Option.isSome(current.info.mtime) ||
        openedInfo.mtime.value.getTime() !== current.info.mtime.value.getTime()
      ) {
        return;
      }
    }
    yield* fs.remove(path, { force: true }).pipe(Effect.ignore);
  }).pipe(Effect.provideService(FileSystem.FileSystem, fs));

const readClaimRecord = (
  path: string,
): Effect.Effect<ClaimRecord | undefined, PlatformError, FileSystem.FileSystem> =>
  readClaimSnapshot(path).pipe(Effect.map((snapshot) => snapshot?.record));

const removeStaleClaim = (
  path: string,
  expected: ClaimSnapshot,
): Effect.Effect<boolean, PlatformError, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const current = yield* readClaimSnapshot(path).pipe(Effect.orElseSucceed(() => undefined));
    if (current === undefined || !claimIdentityMatches(expected, current)) return false;
    yield* fs
      .remove(path, { force: true })
      .pipe(
        Effect.catchTag("PlatformError", (error) =>
          isNotFound(error) ? Effect.void : Effect.fail(error),
        ),
      );
    return true;
  });

const acquirePortClaimInternal = (
  port: number,
  root = CLAIM_ROOT,
): Effect.Effect<
  PortClaim,
  PlatformError | PortAllocationError | PortClaimCollisionError,
  FileSystem.FileSystem
> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    yield* fs.makeDirectory(root, { recursive: true });
    const path = claimPath(port, root);
    const token = randomUUID();
    // oxlint-disable-next-line effecttsgo/prefer-schema-over-json -- Atomic claim records are a tiny native filesystem protocol payload.
    const contents = JSON.stringify({ pid: process.pid, token });

    for (let attempt = 0; attempt < MAX_CLAIM_ATTEMPTS; attempt += 1) {
      let openedInfo: FileSystem.File.Info | undefined;
      let created = false;
      const openedExit = yield* Effect.exit(
        Effect.scoped(
          fs.open(path, { flag: "wx", mode: 0o600 }).pipe(
            Effect.flatMap((handle) => {
              created = true;
              return handle.stat.pipe(
                Effect.tap((info) => Effect.sync(() => (openedInfo = info))),
                Effect.andThen(handle.writeAll(new TextEncoder().encode(contents))),
              );
            }),
          ),
        ),
      );
      if (Exit.isSuccess(openedExit)) return { path, port, token };
      yield* Effect.uninterruptible(removeCreatedClaim(path, contents, openedInfo, created, fs));
      const failure = Cause.findErrorOption(openedExit.cause);
      if (Option.isNone(failure)) return yield* Effect.failCause(openedExit.cause);
      if (!isAlreadyExists(failure.value)) {
        return yield* failure.value;
      }
      const inspection = yield* inspectClaim(path);
      if (inspection === undefined) continue;
      if (!inspection.stale) {
        return yield* new PortClaimCollisionError({ port });
      }
      if (!(yield* removeStaleClaim(path, inspection.snapshot))) continue;
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
  root = CLAIM_ROOT,
): Effect.Effect<PortClaim, PortAllocationError | PortClaimCollisionError, FileSystem.FileSystem> =>
  acquirePortClaimInternal(port, root).pipe(
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

const bindPort = (port: number): Effect.Effect<BoundPort, PortAllocationError> =>
  Effect.callback<BoundPort, PortAllocationError>((resume, signal) => {
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
    server.listen({ port, host: "127.0.0.1", signal }, () => {
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
    return Effect.sync(() => server.off("error", onError)).pipe(
      Effect.andThen(closeServer(server)),
    );
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
  reservations: Map<PortField, ReadonlyArray<Server>>,
  fields: ReadonlyArray<PortField>,
): Effect.Effect<void> =>
  // Cleanup must finish the ownership handoff even if the caller is
  // interrupted between releasing individual fields.
  Effect.uninterruptible(
    Effect.forEach(
      uniquePortFields(fields),
      (field) => {
        const servers = reservations.get(field);
        if (servers === undefined) return Effect.void;
        return Effect.forEach(servers, closeServer, { discard: true }).pipe(
          Effect.tap(() => Effect.sync(() => reservations.delete(field))),
        );
      },
      { discard: true },
    ),
  );

const releaseClaims = (
  claims: Map<PortField, ReadonlyArray<PortClaim>>,
  fields: ReadonlyArray<PortField>,
  fs: FileSystem.FileSystem,
): Effect.Effect<void> =>
  Effect.uninterruptible(
    Effect.forEach(
      uniquePortFields(fields),
      (field) => {
        const fieldClaims = claims.get(field);
        if (fieldClaims === undefined) return Effect.void;
        return Effect.forEach(fieldClaims, (claim) => releasePortClaim(claim, fs), {
          discard: true,
        }).pipe(Effect.tap(() => Effect.sync(() => claims.delete(field))));
      },
      { discard: true },
    ),
  );

const claimAndBind = (
  field: PortField,
  basePort: number,
  claims: Map<PortField, ReadonlyArray<PortClaim>>,
  fs: FileSystem.FileSystem,
  root: string,
): Effect.Effect<PortAllocation, PortAllocationError | PortClaimCollisionError> =>
  Effect.suspend(() => {
    const bound: Array<BoundPort> = [];
    const acquiredClaims: Array<PortClaim> = [];
    const existingClaims = claims.get(field);
    const cleanup = Effect.all([releaseBoundPorts(bound), releasePortClaims(acquiredClaims, fs)], {
      discard: true,
    });

    return Effect.gen(function* () {
      for (const port of portsForField(field, basePort)) {
        bound.push(yield* Effect.interruptible(bindPort(port)));
      }

      if (existingClaims === undefined) {
        for (const port of portsForField(field, basePort)) {
          const claim = yield* Effect.interruptible(
            acquirePortClaim(port, root).pipe(Effect.provideService(FileSystem.FileSystem, fs)),
          );
          acquiredClaims.push(claim);
        }
        yield* Effect.uninterruptible(Effect.sync(() => claims.set(field, acquiredClaims)));
      }

      return { ports: bound, basePort };
    }).pipe(Effect.onError(() => cleanup));
  });

const releaseBoundPorts = (bound: ReadonlyArray<BoundPort>): Effect.Effect<void> =>
  Effect.uninterruptible(
    Effect.forEach(bound, ({ server }) => closeServer(server), { discard: true }),
  );

const releasePortClaims = (
  claims: ReadonlyArray<PortClaim>,
  fs: FileSystem.FileSystem,
): Effect.Effect<void> =>
  Effect.uninterruptible(
    Effect.forEach(claims, (claim) => releasePortClaim(claim, fs), { discard: true }),
  );

const reserveReservations = (
  ports: PortSet,
  reservations: Map<PortField, ReadonlyArray<Server>>,
  claims: Map<PortField, ReadonlyArray<PortClaim>>,
  fields: ReadonlyArray<PortField>,
  fs: FileSystem.FileSystem,
  root: string,
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
        return Effect.uninterruptibleMask(() =>
          claimAndBind(field, port, claims, fs, root).pipe(
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
            Effect.tap(({ ports: boundPorts }) =>
              Effect.sync(() => {
                reservations.set(
                  field,
                  boundPorts.map(({ server }) => server),
                );
                acquired.push(field);
                if (!existingClaim) acquiredClaims.push(field);
              }),
            ),
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
  reservations: Map<PortField, ReadonlyArray<Server>>,
  claims: Map<PortField, ReadonlyArray<PortClaim>>,
  fs: FileSystem.FileSystem,
  root: string,
): PortLease => {
  const lock = Semaphore.makeUnsafe(1);
  return {
    ports,
    reserve: (fields) =>
      lock.withPermit(reserveReservations(ports, reservations, claims, fields, fs, root)),
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
  claims: Map<PortField, ReadonlyArray<PortClaim>>,
  fs: FileSystem.FileSystem,
  root: string,
  attempt = 0,
): Effect.Effect<
  PortAllocation,
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
  return Effect.suspend(() => {
    const bound: Array<BoundPort> = [];
    const acquiredClaims: Array<PortClaim> = [];
    const cleanup = Effect.all([releaseBoundPorts(bound), releasePortClaims(acquiredClaims, fs)], {
      discard: true,
    });

    return Effect.gen(function* () {
      const first = yield* Effect.interruptible(bindPort(0));
      bound.push(first);
      const candidatePorts = portsForField(field, first.port);
      if (candidatePorts.some((port) => port < 1 || port > 65_535 || exclude.has(port))) {
        yield* cleanup;
        return yield* reserveRandomPort(exclude, field, claims, fs, root, attempt + 1);
      }
      for (const port of candidatePorts.slice(1)) {
        bound.push(yield* Effect.interruptible(bindPort(port)));
      }

      for (const port of candidatePorts) {
        const claim = yield* Effect.interruptible(
          acquirePortClaim(port, root).pipe(Effect.provideService(FileSystem.FileSystem, fs)),
        );
        acquiredClaims.push(claim);
      }
      yield* Effect.uninterruptible(Effect.sync(() => claims.set(field, acquiredClaims)));
      return { ports: bound, basePort: first.port };
    }).pipe(
      Effect.catchTag("PortClaimCollisionError", () => {
        return cleanup.pipe(
          Effect.andThen(reserveRandomPort(exclude, field, claims, fs, root, attempt + 1)),
        );
      }),
      Effect.catchTag("PortAllocationError", (error) =>
        error.reason === "unavailable"
          ? cleanup.pipe(
              Effect.andThen(reserveRandomPort(exclude, field, claims, fs, root, attempt + 1)),
            )
          : Effect.fail(error),
      ),
      Effect.onError(() => cleanup),
    );
  });
};

const withPortField = (field: PortField, error: PortAllocationError): PortAllocationError =>
  new PortAllocationError({
    detail: error.detail,
    cause: error.cause,
    field,
    reason: error.reason,
    ...(error.port === undefined ? {} : { port: error.port }),
  });

const decodePortSet = (
  partial: Partial<Record<PortField, number>>,
): Effect.Effect<PortSet, PortAllocationError> =>
  Schema.decodeEffect(PortSetSchema)(partial).pipe(
    Effect.mapError(
      (cause) =>
        new PortAllocationError({
          detail: "Allocated ports did not match the port catalog",
          cause,
        }),
    ),
  );

export const reservePortSet = (
  requests: ReadonlyArray<PortReservationRequest>,
  options: PortSelectionOptions = {},
): Effect.Effect<PortLease, PortAllocationError, FileSystem.FileSystem> =>
  Effect.suspend(() => {
    const reservations = new Map<PortField, ReadonlyArray<Server>>();
    const claims = new Map<PortField, ReadonlyArray<PortClaim>>();
    const root = CLAIM_ROOT;
    const reserve = (fs: FileSystem.FileSystem) =>
      Effect.gen(function* () {
        const reserved = options.reserved ?? new Set<number>();
        const allocated = new Set<number>();
        const partial: Partial<Record<PortField, number>> = {};

        const bindAndRegister = (
          field: PortField,
          acquisition: Effect.Effect<PortAllocation, PortAllocationError | PortClaimCollisionError>,
        ) =>
          Effect.uninterruptibleMask(() =>
            Effect.gen(function* () {
              const result = yield* acquisition.pipe(
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
              );
              reservations.set(
                field,
                result.ports.map(({ server }) => server),
              );
              return result;
            }),
          );

        for (const request of uniqueFields(requests)) {
          const selection = request.selection;
          const exclude = new Set([
            ...reserved,
            ...allocated,
            ...(selection.kind === "automatic" ? (selection.excluded ?? []) : []),
          ]);
          let allocation: PortAllocation;

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
            const selectedPorts = portsForField(request.field, selection.port);
            if (selectedPorts.some((port) => port < 1 || port > 65_535 || exclude.has(port))) {
              return yield* new PortAllocationError({
                detail: `Port ${selection.port} is not available`,
                field: request.field,
                port: selection.port,
              });
            }
            allocation = yield* bindAndRegister(
              request.field,
              claimAndBind(request.field, selection.port, claims, fs, root),
            );
          } else if (
            selection.preferred !== undefined &&
            selection.preferred > 0 &&
            portsForField(request.field, selection.preferred).every(
              (port) => port <= 65_535 && !exclude.has(port),
            )
          ) {
            const preferred = selection.preferred;
            allocation = yield* bindAndRegister(
              request.field,
              claimAndBind(request.field, preferred, claims, fs, root).pipe(
                Effect.catchTag("PortClaimCollisionError", () =>
                  reserveRandomPort(exclude, request.field, claims, fs, root).pipe(
                    Effect.provideService(FileSystem.FileSystem, fs),
                  ),
                ),
                Effect.catchTag("PortAllocationError", (error) =>
                  error.reason === "unavailable"
                    ? reserveRandomPort(exclude, request.field, claims, fs, root).pipe(
                        Effect.provideService(FileSystem.FileSystem, fs),
                      )
                    : Effect.fail(error),
                ),
              ),
            );
          } else {
            allocation = yield* bindAndRegister(
              request.field,
              reserveRandomPort(exclude, request.field, claims, fs, root).pipe(
                Effect.provideService(FileSystem.FileSystem, fs),
              ),
            );
          }

          for (const port of portsForField(request.field, allocation.basePort)) {
            allocated.add(port);
          }
          partial[request.field] = allocation.basePort;
        }

        const ports = yield* decodePortSet(partial);
        return makePortLease(ports, reservations, claims, fs, root);
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
