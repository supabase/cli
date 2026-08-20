import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Cause, Data, Effect, FileSystem, Option, Schema, Semaphore } from "effect";
import { PlatformError } from "effect/PlatformError";
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
  /** @internal isolated claim namespace for allocator integration tests. */
  readonly claimRoot?: string;
  /** @internal deterministic interruption hook used by allocator integration tests. */
  readonly onBound?: (field: PortField, bound: BoundPort) => Effect.Effect<void>;
  /** @internal deterministic interruption hook for claim-to-lease handoff tests. */
  readonly onClaimed?: (field: PortField, claim: PortClaim) => Effect.Effect<void>;
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

interface ClaimSnapshot {
  readonly contents: string;
  readonly record: ClaimRecord | undefined;
  readonly info: FileSystem.File.Info;
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

const isNotFound = (error: PlatformError): boolean => error.reason._tag === "NotFound";
const isAlreadyExists = (error: PlatformError): boolean => error.reason._tag === "AlreadyExists";

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
          isNotFound(error) ? Effect.succeed(undefined) : Effect.fail(error),
        ),
      );
    if (contents === undefined) return undefined;
    const info = yield* fs
      .stat(path)
      .pipe(
        Effect.catchTag("PlatformError", (error) =>
          isNotFound(error) ? Effect.succeed(undefined) : Effect.fail(error),
        ),
      );
    if (info === undefined) return undefined;
    return { contents, record: parseClaimRecord(contents), info };
  });

const claimIsStale = (snapshot: ClaimSnapshot): boolean => {
  if (snapshot.info.type !== "File") return false;
  if (snapshot.record !== undefined) return !isProcessAlive(snapshot.record.pid);
  return (
    Option.isSome(snapshot.info.mtime) &&
    Date.now() - snapshot.info.mtime.value.getTime() > CLAIM_STALE_AFTER_MS
  );
};

const inspectClaim = (
  path: string,
): Effect.Effect<
  { readonly snapshot: ClaimSnapshot; readonly stale: boolean } | undefined,
  PlatformError,
  FileSystem.FileSystem
> =>
  readClaimSnapshot(path).pipe(
    Effect.map((snapshot) =>
      snapshot === undefined ? undefined : { snapshot, stale: claimIsStale(snapshot) },
    ),
  );

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
      if (openedExit._tag === "Success") return { path, port, token };
      yield* Effect.uninterruptible(removeCreatedClaim(path, contents, openedInfo, created, fs));
      const failure = Cause.findErrorOption(openedExit.cause);
      if (Option.isNone(failure)) return yield* Effect.failCause(openedExit.cause);
      if (!isAlreadyExists(failure.value)) {
        return yield* Effect.fail(failure.value);
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

const claimedPorts = (
  root = CLAIM_ROOT,
): Effect.Effect<ReadonlySet<number>, PortAllocationError, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const entries = yield* fs
      .readDirectory(root)
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
      const path = join(root, entry);
      let inspection = yield* inspectClaim(path);
      if (inspection === undefined || inspection.snapshot.info.type !== "File") continue;
      while (inspection.stale) {
        const expected = inspection.snapshot;
        const removed = yield* Effect.acquireUseRelease(
          Effect.interruptible(bindPort(port)),
          () => Effect.interruptible(removeStaleClaim(path, expected)),
          ({ server }) => closeServer(server),
        );
        if (removed) break;
        inspection = yield* inspectClaim(path);
        if (inspection === undefined) break;
      }
      if (inspection !== undefined && !inspection.stale) ports.add(port);
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
  root: string,
): Effect.Effect<BoundPort, PortAllocationError | PortClaimCollisionError> => {
  const existingClaim = claims.get(field);
  return Effect.gen(function* () {
    const bound = yield* Effect.interruptible(bindPort(port));
    if (existingClaim !== undefined) {
      claims.set(field, existingClaim);
      return bound;
    }

    const claimExit = yield* Effect.exit(
      Effect.interruptible(
        acquirePortClaim(port, root).pipe(Effect.provideService(FileSystem.FileSystem, fs)),
      ),
    );
    if (claimExit._tag === "Failure") {
      yield* closeServer(bound.server);
      return yield* Effect.failCause(claimExit.cause);
    }
    yield* Effect.uninterruptible(Effect.sync(() => claims.set(field, claimExit.value)));
    return bound;
  });
};

const reserveReservations = (
  ports: PortSet,
  reservations: Map<PortField, Server>,
  claims: Map<PortField, PortClaim>,
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
            Effect.tap(({ server }) =>
              Effect.sync(() => {
                reservations.set(field, server);
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
  reservations: Map<PortField, Server>,
  claims: Map<PortField, PortClaim>,
  fs: FileSystem.FileSystem,
  claimRoot: string,
): PortLease => {
  const lock = Semaphore.makeUnsafe(1);
  return {
    ports,
    reserve: (fields) =>
      lock.withPermit(reserveReservations(ports, reservations, claims, fields, fs, claimRoot)),
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
  root: string,
  onClaimed: PortAllocationOptions["onClaimed"],
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
  return Effect.gen(function* () {
    const bound = yield* Effect.interruptible(bindPort(0));
    if (exclude.has(bound.port)) {
      yield* closeServer(bound.server);
      return yield* reserveRandomPort(exclude, field, claims, fs, root, onClaimed, attempt + 1);
    }

    const claimExit = yield* Effect.exit(
      Effect.interruptible(
        acquirePortClaim(bound.port, root).pipe(Effect.provideService(FileSystem.FileSystem, fs)),
      ),
    );
    if (claimExit._tag === "Success") {
      const handoff = yield* Effect.exit(
        Effect.interruptible(onClaimed?.(field, claimExit.value) ?? Effect.void),
      );
      if (handoff._tag === "Failure") {
        yield* Effect.uninterruptible(releasePortClaim(claimExit.value, fs));
        yield* closeServer(bound.server);
        return yield* Effect.failCause(handoff.cause);
      }
      yield* Effect.uninterruptible(Effect.sync(() => claims.set(field, claimExit.value)));
      return bound;
    }

    yield* closeServer(bound.server);
    const failure = Cause.findErrorOption(claimExit.cause);
    if (Option.isSome(failure) && failure.value instanceof PortClaimCollisionError) {
      return yield* reserveRandomPort(exclude, field, claims, fs, root, onClaimed, attempt + 1);
    }
    if (Option.isSome(failure) && failure.value instanceof PlatformError) {
      return yield* Effect.fail(portAllocationFromCause(bound.port, failure.value));
    }
    if (Option.isSome(failure) && failure.value instanceof PortAllocationError) {
      return yield* Effect.fail(failure.value);
    }
    return yield* Effect.failCause(
      Cause.map(claimExit.cause, (error) =>
        error instanceof PortClaimCollisionError || error instanceof PortAllocationError
          ? error
          : portAllocationFromCause(bound.port, error),
      ),
    );
  });
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
    const reserved = new Set([
      ...(options.reserved ?? []),
      ...(yield* claimedPorts(options.claimRoot)),
    ]);
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
    const claimRoot = options.claimRoot ?? CLAIM_ROOT;
    const reserve = (fs: FileSystem.FileSystem) =>
      Effect.gen(function* () {
        const reserved = options.reserved ?? new Set<number>();
        const allocated = new Set<number>();
        const partial: Partial<Record<PortField, number>> = {};

        const bindAndRegister = (
          field: PortField,
          acquisition: Effect.Effect<BoundPort, PortAllocationError | PortClaimCollisionError>,
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
              claimAndBind(request.field, selection.port, claims, fs, claimRoot),
            );
          } else if (
            selection.preferred !== undefined &&
            selection.preferred > 0 &&
            !exclude.has(selection.preferred)
          ) {
            const preferred = selection.preferred;
            bound = yield* bindAndRegister(
              request.field,
              claimAndBind(request.field, preferred, claims, fs, claimRoot).pipe(
                Effect.catchTag("PortClaimCollisionError", () =>
                  reserveRandomPort(
                    exclude,
                    request.field,
                    claims,
                    fs,
                    claimRoot,
                    options.onClaimed,
                  ).pipe(Effect.provideService(FileSystem.FileSystem, fs)),
                ),
                Effect.catchTag("PortAllocationError", (error) =>
                  error.reason === "unavailable"
                    ? reserveRandomPort(
                        exclude,
                        request.field,
                        claims,
                        fs,
                        claimRoot,
                        options.onClaimed,
                      ).pipe(Effect.provideService(FileSystem.FileSystem, fs))
                    : Effect.fail(error),
                ),
              ),
            );
          } else {
            bound = yield* bindAndRegister(
              request.field,
              reserveRandomPort(
                exclude,
                request.field,
                claims,
                fs,
                claimRoot,
                options.onClaimed,
              ).pipe(Effect.provideService(FileSystem.FileSystem, fs)),
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
          claimRoot,
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
