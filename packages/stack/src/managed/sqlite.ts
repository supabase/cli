import { chmodSync, closeSync, mkdirSync, openSync } from "node:fs";
import { dirname } from "node:path";
import { Duration, Effect, Layer, Schedule, Schema } from "effect";
import {
  DuplicateManagedIdentityError,
  DuplicateManagedPortKeyError,
  InvalidManagedOwnerPidError,
  InvalidManagedPortError,
  MANAGED_REGISTRY_SCHEMA_VERSION,
  ManagedOperationOwnershipError,
  ManagedPendingStackUpdateError,
  ManagedPortReservationError,
  ManagedRunningStackPortChangeError,
  ManagedStackNotFoundError,
  UnsupportedManagedRegistryVersionError,
  type ManagedCheckoutLocation,
  type ManagedOperationKind,
  type ManagedOperationRecord,
  type ManagedOperationStatus,
  type ManagedPortAssignment,
  type ManagedPortIntent,
  type ManagedRuntime,
  type ManagedRuntimeMetadata,
  type ManagedRuntimeRequest,
  type ManagedStackLifecycle,
  type ManagedStackPaths,
  type ManagedStackRecord,
  type ManagedStackStatus,
} from "./model.ts";
import type {
  ClaimManagedOperationFailure,
  ClaimManagedOperationInput,
  ClaimManagedOperationResult,
  ManagedStackRepositoryShape,
  OwnedManagedStackFailure,
  PrepareOrdinaryStackFailure,
  PrepareOrdinaryStackInput,
  PrepareOrdinaryStackResult,
  ReconcileManagedOperationFailure,
  ReconcileManagedOperationResult,
  UpdateManagedStackFailure,
  UpdateManagedStackInput,
} from "./repository.ts";
import {
  assertManagedOwnerPid,
  assertManagedStackUpdatable,
  managedStackOccupiesPorts,
  ManagedStackRepository,
  reconcileManagedPortAssignments,
  validateManagedPortAssignments,
} from "./repository.ts";
import { errorCode } from "./error-code.ts";
import { failsWith, neverFails } from "./failure.ts";

type SqliteValue = null | number | string;

interface ManagedSqliteStatement {
  run(parameters?: ReadonlyArray<SqliteValue>): void;
  get(parameters?: ReadonlyArray<SqliteValue>): unknown;
  all(parameters?: ReadonlyArray<SqliteValue>): ReadonlyArray<unknown>;
}

export interface ManagedSqliteDatabase {
  exec(sql: string): void;
  prepare(sql: string): ManagedSqliteStatement;
  close(): void;
}

const stringRecordSchema = Schema.Record(Schema.String, Schema.String);
const numberRecordSchema = Schema.Record(Schema.String, Schema.Number);
const runtimeMetadataSchema = Schema.Struct({
  pid: Schema.optional(Schema.Number),
  socketPath: Schema.optional(Schema.String),
  processIds: numberRecordSchema,
  containerIds: stringRecordSchema,
});
const decodeStringRecord = Schema.decodeUnknownSync(stringRecordSchema);
const decodeRuntimeMetadata = Schema.decodeUnknownSync(runtimeMetadataSchema);

const getField = (row: unknown, field: string): unknown => {
  if (typeof row !== "object" || row === null) {
    throw new Error(`SQLite row is missing ${field}`);
  }
  return Reflect.get(row, field);
};

const getString = (row: unknown, field: string): string => {
  const value = getField(row, field);
  if (typeof value !== "string") {
    throw new Error(`SQLite column ${field} is not a string`);
  }
  return value;
};

const getOptionalString = (row: unknown, field: string): string | undefined => {
  const value = getField(row, field);
  if (value === null || value === undefined) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new Error(`SQLite column ${field} is not a nullable string`);
  }
  return value;
};

const getNumber = (row: unknown, field: string): number => {
  const value = getField(row, field);
  if (typeof value !== "number") {
    throw new Error(`SQLite column ${field} is not a number`);
  }
  return value;
};

const getOptionalNumber = (row: unknown, field: string): number | undefined => {
  const value = getField(row, field);
  if (value === null || value === undefined) {
    return undefined;
  }
  if (typeof value !== "number") {
    throw new Error(`SQLite column ${field} is not a nullable number`);
  }
  return value;
};

const parseJson = (value: string): unknown => JSON.parse(value);

const managedRuntimeRequest = (value: string): ManagedRuntimeRequest => {
  if (value === "auto" || value === "docker" || value === "native") {
    return value;
  }
  throw new Error(`Unknown managed runtime request ${value}`);
};

const managedRuntime = (value: string | undefined): ManagedRuntime | undefined => {
  if (value === undefined || value === "docker" || value === "native") {
    return value;
  }
  throw new Error(`Unknown managed runtime ${value}`);
};

const managedStackStatus = (value: string): ManagedStackStatus => {
  if (value === "active" || value === "pending" || value === "tombstoned") {
    return value;
  }
  throw new Error(`Unknown managed stack status ${value}`);
};

const managedStackLifecycle = (value: string): ManagedStackLifecycle => {
  if (
    value === "failed" ||
    value === "running" ||
    value === "starting" ||
    value === "stopped" ||
    value === "stopping"
  ) {
    return value;
  }
  throw new Error(`Unknown managed stack lifecycle ${value}`);
};

const managedOperationKind = (value: string): ManagedOperationKind => {
  if (value === "delete" || value === "start" || value === "stop" || value === "update") {
    return value;
  }
  throw new Error(`Unknown managed operation kind ${value}`);
};

const managedOperationStatus = (value: string): ManagedOperationStatus => {
  if (value === "active" || value === "completed" || value === "failed") {
    return value;
  }
  throw new Error(`Unknown managed operation status ${value}`);
};

const managedPortIntent = (value: string): ManagedPortIntent => {
  if (value === "automatic" || value === "exact") {
    return value;
  }
  throw new Error(`Unknown managed port intent ${value}`);
};

const isSqliteBusy = (error: unknown): boolean => {
  const code = errorCode(error);
  if (code === "SQLITE_BUSY" || code === "SQLITE_LOCKED") {
    return true;
  }
  return error instanceof Error && /database is (?:busy|locked)/i.test(error.message);
};

const WAL_CONVERSION_RETRY_MS = 10;
const WAL_CONVERSION_RETRY_CEILING_MS = 100;
const WAL_CONVERSION_BUDGET_MS = 4_000;

/**
 * Converting a fresh registry to WAL can lose a race with another process doing
 * the same thing, and SQLite reports that as a busy error instead of waiting it
 * out under `busy_timeout`. The conversion is therefore retried on a schedule:
 * tight at first, capped so a long contention window is not polled every 10 ms,
 * and bounded by a total budget. The retry is a schedule rather than a blocking
 * wait, so a cold start under contention suspends the fiber instead of stalling
 * the event loop that is driving every other caller of this process.
 */
const walConversionSchedule = Schedule.exponential(Duration.millis(WAL_CONVERSION_RETRY_MS)).pipe(
  Schedule.modifyDelay(({ duration }) =>
    Effect.succeed(
      Duration.millis(Math.min(Duration.toMillis(duration), WAL_CONVERSION_RETRY_CEILING_MS)),
    ),
  ),
  Schedule.upTo({ duration: Duration.millis(WAL_CONVERSION_BUDGET_MS) }),
);

const enableWriteAheadLogging = (database: ManagedSqliteDatabase): Effect.Effect<void> =>
  Effect.try({
    try: () => {
      database.exec("PRAGMA journal_mode = WAL");
    },
    catch: (error: unknown) => error,
  }).pipe(
    Effect.retry({ while: isSqliteBusy, schedule: walConversionSchedule }),
    // Contention that never clears within the budget is not a managed failure a
    // caller could recover from, so the driver's own error stays a defect —
    // exactly as an immediate non-busy failure of this pragma always has.
    Effect.orDie,
  );

const rollbackPreservingCause = (database: ManagedSqliteDatabase): void => {
  try {
    database.exec("ROLLBACK");
  } catch {
    // The original transaction error is more useful than a secondary rollback failure.
  }
};

const migrateSchema = (database: ManagedSqliteDatabase): void => {
  database.exec("BEGIN IMMEDIATE");
  try {
    const versionRow = database.prepare("PRAGMA user_version").get();
    const version = getNumber(versionRow, "user_version");
    if (version !== 0 && version !== MANAGED_REGISTRY_SCHEMA_VERSION) {
      throw new UnsupportedManagedRegistryVersionError({
        found: version,
        supported: MANAGED_REGISTRY_SCHEMA_VERSION,
      });
    }
    if (version === MANAGED_REGISTRY_SCHEMA_VERSION) {
      database.exec("COMMIT");
      return;
    }
    database.exec(`
      CREATE TABLE projects (
        id TEXT PRIMARY KEY,
        created_at TEXT NOT NULL
      );

      CREATE TABLE checkouts (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id),
        created_at TEXT NOT NULL
      );

      CREATE TABLE checkout_locations (
        id TEXT PRIMARY KEY,
        checkout_id TEXT NOT NULL REFERENCES checkouts(id),
        canonical_path TEXT NOT NULL UNIQUE,
        last_seen_at TEXT NOT NULL
      );
      CREATE UNIQUE INDEX one_ordinary_location_per_checkout
        ON checkout_locations(checkout_id);

      CREATE TABLE contexts (
        id TEXT PRIMARY KEY,
        checkout_id TEXT NOT NULL REFERENCES checkouts(id),
        created_at TEXT NOT NULL
      );

      CREATE TABLE stacks (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id),
        checkout_id TEXT NOT NULL REFERENCES checkouts(id),
        context_id TEXT NOT NULL REFERENCES contexts(id),
        name TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('pending', 'active', 'tombstoned')),
        lifecycle TEXT NOT NULL CHECK (lifecycle IN ('stopped', 'starting', 'running', 'stopping', 'failed')),
        runtime_request TEXT NOT NULL CHECK (runtime_request IN ('auto', 'docker', 'native')),
        runtime TEXT CHECK (runtime IN ('docker', 'native')),
        root_path TEXT NOT NULL,
        data_path TEXT NOT NULL,
        logs_path TEXT NOT NULL,
        runtime_path TEXT NOT NULL,
        config_fingerprint TEXT,
        credentials_reference TEXT,
        service_versions_json TEXT NOT NULL,
        runtime_metadata_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        tombstoned_at TEXT
      );
      CREATE UNIQUE INDEX one_live_stack_per_identity
        ON stacks(checkout_id, context_id, name)
        WHERE status != 'tombstoned';

      CREATE TABLE ports (
        stack_id TEXT NOT NULL REFERENCES stacks(id) ON DELETE CASCADE,
        key TEXT NOT NULL,
        port INTEGER NOT NULL,
        intent TEXT NOT NULL CHECK (intent IN ('automatic', 'exact')),
        PRIMARY KEY (stack_id, key)
      );
      CREATE INDEX port_assignments_by_port ON ports(port);

      CREATE TABLE operations (
        token TEXT PRIMARY KEY,
        stack_id TEXT NOT NULL REFERENCES stacks(id) ON DELETE CASCADE,
        kind TEXT NOT NULL CHECK (kind IN ('start', 'stop', 'delete', 'update')),
        status TEXT NOT NULL CHECK (status IN ('active', 'completed', 'failed')),
        owner_pid INTEGER,
        started_at TEXT NOT NULL,
        finished_at TEXT,
        error TEXT
      );
      CREATE UNIQUE INDEX one_active_operation_per_stack
        ON operations(stack_id)
        WHERE status = 'active';

      PRAGMA user_version = ${MANAGED_REGISTRY_SCHEMA_VERSION};
    `);
    database.exec("COMMIT");
  } catch (error: unknown) {
    rollbackPreservingCause(database);
    throw error;
  }
};

/**
 * Prepares a freshly opened handle for use as the registry.
 *
 * `busy_timeout` is set first so every later statement waits out a writer on its
 * own, then the file is converted to WAL, and only then is the schema read and
 * created. A registry written by an unsupported version is the one outcome a
 * caller can act on, so it is the only failure this reports; everything else the
 * driver raises stays a defect.
 */
const initializeRegistry = (
  database: ManagedSqliteDatabase,
): Effect.Effect<void, UnsupportedManagedRegistryVersionError> =>
  Effect.gen(function* () {
    yield* Effect.sync(() => {
      database.exec("PRAGMA busy_timeout = 5000");
      database.exec("PRAGMA foreign_keys = ON");
    });
    yield* enableWriteAheadLogging(database);
    yield* Effect.try({
      try: () => {
        migrateSchema(database);
      },
      catch: failsWith<UnsupportedManagedRegistryVersionError>(
        UnsupportedManagedRegistryVersionError,
      ),
    });
  });

const commitPreservingCause = (database: ManagedSqliteDatabase): void => {
  try {
    database.exec("COMMIT");
  } catch (error: unknown) {
    rollbackPreservingCause(database);
    throw error;
  }
};

/**
 * `BEGIN`, the decision's statements, and `COMMIT` as one synchronous block.
 *
 * Atomicity here rests on the drivers being synchronous and the handle being
 * single-threaded: nothing else can run between the statements, so a partially
 * applied decision is never observable and two transactions can never nest on
 * the same connection. That only holds while the whole block is one JavaScript
 * turn — splitting the boundary across effects would reintroduce a suspension
 * point where the fiber scheduler could preempt at its operation budget and let
 * another fiber `BEGIN` on this very handle.
 */
const runTransaction = <A>(
  database: ManagedSqliteDatabase,
  begin: "BEGIN" | "BEGIN IMMEDIATE",
  run: () => A,
): A => {
  database.exec(begin);
  let decided: A;
  try {
    decided = run();
  } catch (error: unknown) {
    rollbackPreservingCause(database);
    throw error;
  }
  commitPreservingCause(database);
  return decided;
};

/**
 * Runs one registry decision inside a transaction. `catchFailure` names the
 * domain failures the decision raises; anything else is a defect, and either way
 * the statement batch has already rolled back.
 */
const transaction = <A, E>(
  database: ManagedSqliteDatabase,
  run: () => A,
  catchFailure: (error: unknown) => E,
): Effect.Effect<A, E> =>
  Effect.try({
    try: () => runTransaction(database, "BEGIN IMMEDIATE", run),
    catch: catchFailure,
  });

const readTransaction = <A>(
  database: ManagedSqliteDatabase,
  run: () => A,
): Effect.Effect<A, never> =>
  Effect.try({ try: () => runTransaction(database, "BEGIN", run), catch: neverFails });

const decodePort = (row: unknown): ManagedPortAssignment => ({
  key: getString(row, "key"),
  port: getNumber(row, "port"),
  intent: managedPortIntent(getString(row, "intent")),
});

const queryPorts = (
  database: ManagedSqliteDatabase,
  stackId: string,
): ReadonlyArray<ManagedPortAssignment> =>
  database
    .prepare("SELECT key, port, intent FROM ports WHERE stack_id = ? ORDER BY key")
    .all([stackId])
    .map(decodePort);

/**
 * Ports for many stacks in one statement, so listing N stacks costs two queries
 * instead of N + 1.
 */
const queryPortsByStack = (
  database: ManagedSqliteDatabase,
  stackIds: ReadonlyArray<string>,
): Map<string, Array<ManagedPortAssignment>> => {
  const byStack = new Map<string, Array<ManagedPortAssignment>>();
  if (stackIds.length === 0) {
    return byStack;
  }
  const placeholders = stackIds.map(() => "?").join(", ");
  const rows = database
    .prepare(
      `SELECT stack_id, key, port, intent FROM ports
       WHERE stack_id IN (${placeholders})
       ORDER BY stack_id, key`,
    )
    .all([...stackIds]);
  for (const row of rows) {
    const stackId = getString(row, "stack_id");
    const assignments = byStack.get(stackId);
    if (assignments === undefined) {
      byStack.set(stackId, [decodePort(row)]);
      continue;
    }
    assignments.push(decodePort(row));
  }
  return byStack;
};

const decodeStackWithPorts = (
  row: unknown,
  ports: ReadonlyArray<ManagedPortAssignment>,
): ManagedStackRecord => {
  const id = getString(row, "id");
  const paths: ManagedStackPaths = {
    root: getString(row, "root_path"),
    data: getString(row, "data_path"),
    logs: getString(row, "logs_path"),
    runtime: getString(row, "runtime_path"),
  };
  return {
    id,
    projectId: getString(row, "project_id"),
    checkoutId: getString(row, "checkout_id"),
    contextId: getString(row, "context_id"),
    name: getString(row, "name"),
    status: managedStackStatus(getString(row, "status")),
    lifecycle: managedStackLifecycle(getString(row, "lifecycle")),
    runtimeRequest: managedRuntimeRequest(getString(row, "runtime_request")),
    runtime: managedRuntime(getOptionalString(row, "runtime")),
    paths,
    ports,
    serviceVersions: decodeStringRecord(parseJson(getString(row, "service_versions_json"))),
    runtimeMetadata: decodeRuntimeMetadata(parseJson(getString(row, "runtime_metadata_json"))),
    configFingerprint: getOptionalString(row, "config_fingerprint"),
    credentialsReference: getOptionalString(row, "credentials_reference"),
    createdAt: getString(row, "created_at"),
    updatedAt: getString(row, "updated_at"),
    tombstonedAt: getOptionalString(row, "tombstoned_at"),
  };
};

const decodeStack = (database: ManagedSqliteDatabase, row: unknown): ManagedStackRecord =>
  decodeStackWithPorts(row, queryPorts(database, getString(row, "id")));

const decodeOperation = (row: unknown): ManagedOperationRecord => ({
  token: getString(row, "token"),
  stackId: getString(row, "stack_id"),
  kind: managedOperationKind(getString(row, "kind")),
  status: managedOperationStatus(getString(row, "status")),
  ownerPid: getOptionalNumber(row, "owner_pid"),
  startedAt: getString(row, "started_at"),
  finishedAt: getOptionalString(row, "finished_at"),
  error: getOptionalString(row, "error"),
});

const getStack = (
  database: ManagedSqliteDatabase,
  stackId: string,
): ManagedStackRecord | undefined => {
  const row = database.prepare("SELECT * FROM stacks WHERE id = ?").get([stackId]);
  return row === undefined ? undefined : decodeStack(database, row);
};

const requireStack = (database: ManagedSqliteDatabase, stackId: string): ManagedStackRecord => {
  const stack = getStack(database, stackId);
  if (stack === undefined) {
    throw new ManagedStackNotFoundError({ stackId });
  }
  return stack;
};

const getActiveOperation = (
  database: ManagedSqliteDatabase,
  stackId: string,
): ManagedOperationRecord | undefined => {
  const row = database
    .prepare("SELECT * FROM operations WHERE stack_id = ? AND status = 'active'")
    .get([stackId]);
  return row === undefined ? undefined : decodeOperation(row);
};

const requireOwnedOperation = (
  database: ManagedSqliteDatabase,
  stackId: string,
  operationToken: string,
): ManagedOperationRecord => {
  const operation = getActiveOperation(database, stackId);
  if (operation === undefined || operation.token !== operationToken) {
    throw new ManagedOperationOwnershipError({ stackId });
  }
  return operation;
};

const replacePorts = (
  database: ManagedSqliteDatabase,
  stackId: string,
  ports: ReadonlyArray<ManagedPortAssignment>,
  lifecycle: ManagedStackLifecycle,
): void => {
  validateManagedPortAssignments(stackId, ports);
  if (managedStackOccupiesPorts(lifecycle)) {
    for (const assignment of ports) {
      const owner = database
        .prepare(
          `SELECT ports.stack_id
           FROM ports
           JOIN stacks ON stacks.id = ports.stack_id
           WHERE ports.port = ? AND ports.stack_id != ?
             AND stacks.status != 'tombstoned'
             AND stacks.lifecycle IN ('starting', 'running', 'stopping')`,
        )
        .get([assignment.port, stackId]);
      if (owner !== undefined) {
        throw new ManagedPortReservationError({
          port: assignment.port,
          ownerStackId: getString(owner, "stack_id"),
        });
      }
    }
  }
  database.prepare("DELETE FROM ports WHERE stack_id = ?").run([stackId]);
  const insert = database.prepare(
    "INSERT INTO ports (stack_id, key, port, intent) VALUES (?, ?, ?, ?)",
  );
  for (const assignment of ports) {
    insert.run([stackId, assignment.key, assignment.port, assignment.intent]);
  }
};

const claimOperation = (
  database: ManagedSqliteDatabase,
  input: ClaimManagedOperationInput,
): ClaimManagedOperationResult => {
  requireStack(database, input.stackId);
  const active = getActiveOperation(database, input.stackId);
  if (active !== undefined) {
    return { acquired: false, operation: active };
  }
  database
    .prepare(
      `INSERT INTO operations
          (token, stack_id, kind, status, owner_pid, started_at)
         VALUES (?, ?, ?, 'active', ?, ?)`,
    )
    .run([input.token, input.stackId, input.kind, input.ownerPid ?? null, input.now]);
  const operation = getActiveOperation(database, input.stackId);
  if (operation === undefined) {
    throw new ManagedOperationOwnershipError({ stackId: input.stackId });
  }
  return { acquired: true, operation };
};

const insertConfiguration = (
  database: ManagedSqliteDatabase,
  input: PrepareOrdinaryStackInput,
): void => {
  const runtimeMetadata: ManagedRuntimeMetadata = input.configuration.runtimeMetadata ?? {
    processIds: {},
    containerIds: {},
  };
  database
    .prepare(
      `INSERT INTO stacks (
        id, project_id, checkout_id, context_id, name, status, lifecycle,
        runtime_request, runtime, root_path, data_path, logs_path, runtime_path,
        config_fingerprint, credentials_reference, service_versions_json,
        runtime_metadata_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run([
      input.stackId,
      input.identity.projectId,
      input.identity.checkoutId,
      input.identity.contextId,
      input.stackName,
      input.configuration.lifecycle ?? "stopped",
      input.configuration.runtimeRequest ?? "auto",
      input.configuration.runtime ?? null,
      input.paths.root,
      input.paths.data,
      input.paths.logs,
      input.paths.runtime,
      input.configuration.configFingerprint ?? null,
      input.configuration.credentialsReference ?? null,
      JSON.stringify(input.configuration.serviceVersions ?? {}),
      JSON.stringify(runtimeMetadata),
      input.now,
      input.now,
    ]);
  replacePorts(
    database,
    input.stackId,
    input.configuration.ports ?? [],
    input.configuration.lifecycle ?? "stopped",
  );
};

const prepareOrdinaryStack = (
  database: ManagedSqliteDatabase,
  input: PrepareOrdinaryStackInput,
): PrepareOrdinaryStackResult => {
  database
    .prepare("INSERT OR IGNORE INTO projects (id, created_at) VALUES (?, ?)")
    .run([input.identity.projectId, input.now]);

  const checkoutRow = database
    .prepare("SELECT project_id FROM checkouts WHERE id = ?")
    .get([input.identity.checkoutId]);
  if (
    checkoutRow !== undefined &&
    getString(checkoutRow, "project_id") !== input.identity.projectId
  ) {
    throw new DuplicateManagedIdentityError({
      identityId: input.identity.checkoutId,
      existingClaim: getString(checkoutRow, "project_id"),
      requestedClaim: input.identity.projectId,
    });
  }
  database
    .prepare("INSERT OR IGNORE INTO checkouts (id, project_id, created_at) VALUES (?, ?, ?)")
    .run([input.identity.checkoutId, input.identity.projectId, input.now]);

  const contextRow = database
    .prepare("SELECT checkout_id FROM contexts WHERE id = ?")
    .get([input.identity.contextId]);
  if (
    contextRow !== undefined &&
    getString(contextRow, "checkout_id") !== input.identity.checkoutId
  ) {
    throw new DuplicateManagedIdentityError({
      identityId: input.identity.contextId,
      existingClaim: getString(contextRow, "checkout_id"),
      requestedClaim: input.identity.checkoutId,
    });
  }
  database
    .prepare(`INSERT OR IGNORE INTO contexts (id, checkout_id, created_at) VALUES (?, ?, ?)`)
    .run([input.identity.contextId, input.identity.checkoutId, input.now]);

  const checkoutLocation = database
    .prepare("SELECT * FROM checkout_locations WHERE checkout_id = ?")
    .get([input.identity.checkoutId]);
  if (
    checkoutLocation !== undefined &&
    getString(checkoutLocation, "canonical_path") !== input.canonicalPath
  ) {
    throw new DuplicateManagedIdentityError({
      identityId: input.identity.checkoutId,
      existingClaim: getString(checkoutLocation, "canonical_path"),
      requestedClaim: input.canonicalPath,
    });
  }
  const pathLocation = database
    .prepare("SELECT * FROM checkout_locations WHERE canonical_path = ?")
    .get([input.canonicalPath]);
  if (
    pathLocation !== undefined &&
    getString(pathLocation, "checkout_id") !== input.identity.checkoutId
  ) {
    throw new DuplicateManagedIdentityError({
      identityId: input.canonicalPath,
      existingClaim: getString(pathLocation, "checkout_id"),
      requestedClaim: input.identity.checkoutId,
    });
  }
  if (checkoutLocation === undefined) {
    database
      .prepare(
        `INSERT INTO checkout_locations
                (id, checkout_id, canonical_path, last_seen_at)
               VALUES (?, ?, ?, ?)`,
      )
      .run([input.locationId, input.identity.checkoutId, input.canonicalPath, input.now]);
  } else {
    database
      .prepare("UPDATE checkout_locations SET last_seen_at = ? WHERE id = ?")
      .run([input.now, getString(checkoutLocation, "id")]);
  }

  const existingRow = database
    .prepare(
      `SELECT * FROM stacks
             WHERE checkout_id = ? AND context_id = ? AND name = ? AND status != 'tombstoned'`,
    )
    .get([input.identity.checkoutId, input.identity.contextId, input.stackName]);
  if (existingRow !== undefined) {
    const stack = decodeStack(database, existingRow);
    const operation = getActiveOperation(database, stack.id);
    return { outcome: "existing", stack, operation };
  }

  insertConfiguration(database, input);
  database
    .prepare(
      `INSERT INTO operations
              (token, stack_id, kind, status, owner_pid, started_at)
             VALUES (?, ?, 'start', 'active', ?, ?)`,
    )
    .run([input.operationToken, input.stackId, input.ownerPid ?? null, input.now]);
  const stack = requireStack(database, input.stackId);
  const operation = getActiveOperation(database, input.stackId);
  if (operation === undefined) {
    throw new ManagedOperationOwnershipError({ stackId: input.stackId });
  }
  return { outcome: "create", stack, operation };
};

const publishPendingStack = (
  database: ManagedSqliteDatabase,
  stackId: string,
  operationToken: string,
  now: string,
): ManagedStackRecord => {
  requireOwnedOperation(database, stackId, operationToken);
  database
    .prepare("UPDATE stacks SET status = 'active', updated_at = ? WHERE id = ?")
    .run([now, stackId]);
  database
    .prepare(
      `UPDATE operations
             SET status = 'completed', finished_at = ?
             WHERE token = ? AND stack_id = ?`,
    )
    .run([now, operationToken, stackId]);
  return requireStack(database, stackId);
};

const abortPendingStack = (
  database: ManagedSqliteDatabase,
  stackId: string,
  operationToken: string,
): void => {
  requireOwnedOperation(database, stackId, operationToken);
  const stack = requireStack(database, stackId);
  if (stack.status !== "pending") {
    throw new ManagedOperationOwnershipError({ stackId });
  }
  database.prepare("DELETE FROM stacks WHERE id = ?").run([stackId]);
};

const selectStacks = (
  database: ManagedSqliteDatabase,
  options?: { readonly includeTombstoned?: boolean },
): ReadonlyArray<ManagedStackRecord> => {
  const rows =
    options?.includeTombstoned === true
      ? database.prepare("SELECT * FROM stacks ORDER BY created_at, id").all()
      : database
          .prepare("SELECT * FROM stacks WHERE status != 'tombstoned' ORDER BY created_at, id")
          .all();
  const portsByStack = queryPortsByStack(
    database,
    rows.map((row) => getString(row, "id")),
  );
  return rows.map((row) => decodeStackWithPorts(row, portsByStack.get(getString(row, "id")) ?? []));
};

const finishOperation = (
  database: ManagedSqliteDatabase,
  stackId: string,
  operationToken: string,
  outcome: "completed" | "failed",
  now: string,
  error?: string,
): void => {
  requireOwnedOperation(database, stackId, operationToken);
  database
    .prepare(
      `UPDATE operations
             SET status = ?, finished_at = ?, error = ?
             WHERE token = ? AND stack_id = ?`,
    )
    .run([outcome, now, error ?? null, operationToken, stackId]);
};

const updateStack = (
  database: ManagedSqliteDatabase,
  input: UpdateManagedStackInput,
): ManagedStackRecord => {
  requireOwnedOperation(database, input.stackId, input.operationToken);
  const current = requireStack(database, input.stackId);
  assertManagedStackUpdatable(current);
  const runtimeRequest = input.runtimeRequest ?? current.runtimeRequest;
  const runtime = input.runtime ?? current.runtime;
  const lifecycle = input.lifecycle ?? current.lifecycle;
  const serviceVersions = input.serviceVersions ?? current.serviceVersions;
  const runtimeMetadata = input.runtimeMetadata ?? current.runtimeMetadata;
  const configFingerprint = input.configFingerprint ?? current.configFingerprint;
  const credentialsReference = input.credentialsReference ?? current.credentialsReference;
  const ports = reconcileManagedPortAssignments(current, input.ports, lifecycle);
  database
    .prepare(
      `UPDATE stacks SET
              lifecycle = ?, runtime_request = ?, runtime = ?,
              service_versions_json = ?, runtime_metadata_json = ?,
              config_fingerprint = ?, credentials_reference = ?, updated_at = ?
             WHERE id = ?`,
    )
    .run([
      lifecycle,
      runtimeRequest,
      runtime ?? null,
      JSON.stringify(serviceVersions),
      JSON.stringify(runtimeMetadata),
      configFingerprint ?? null,
      credentialsReference ?? null,
      input.now,
      input.stackId,
    ]);
  replacePorts(database, input.stackId, ports, lifecycle);
  return requireStack(database, input.stackId);
};

const selectActiveOperations = (
  database: ManagedSqliteDatabase,
  startedBefore?: string,
): ReadonlyArray<ManagedOperationRecord> => {
  // The token tie-break keeps claims that share one `startedAt` in a
  // defined order instead of whatever order the sorter happens to emit.
  const rows =
    startedBefore === undefined
      ? database
          .prepare("SELECT * FROM operations WHERE status = 'active' ORDER BY started_at, token")
          .all()
      : database
          .prepare(
            `SELECT * FROM operations
                 WHERE status = 'active' AND started_at < ? ORDER BY started_at, token`,
          )
          .all([startedBefore]);
  return rows.map(decodeOperation);
};

const reconcileOperation = (
  database: ManagedSqliteDatabase,
  stackId: string,
  operationToken: string,
  lifecycle: ManagedStackLifecycle,
  now: string,
): ReconcileManagedOperationResult => {
  requireOwnedOperation(database, stackId, operationToken);
  const current = requireStack(database, stackId);
  if (current.status === "tombstoned") {
    // A tombstoned row under a live claim is a deletion that died before
    // releasing it. Registry state is already final, so recovery only
    // releases the claim; reviving a lifecycle here would resurrect a
    // deleted stack, and dropping the row would break idempotent deletion.
    database
      .prepare(
        `UPDATE operations SET
                status = 'failed', finished_at = ?, error = ?
               WHERE token = ? AND stack_id = ?`,
      )
      .run([now, "Recovered after an abandoned deletion", operationToken, stackId]);
    return { outcome: "tombstoned", stack: current };
  }
  if (current.status === "pending" && lifecycle === "stopped") {
    database.prepare("DELETE FROM stacks WHERE id = ?").run([stackId]);
    return { outcome: "discarded" };
  }
  replacePorts(database, stackId, current.ports, lifecycle);
  database
    .prepare(
      `UPDATE stacks SET
              status = CASE WHEN status = 'pending' THEN 'active' ELSE status END,
              lifecycle = ?, updated_at = ?
             WHERE id = ?`,
    )
    .run([lifecycle, now, stackId]);
  database
    .prepare(
      `UPDATE operations SET
              status = 'failed', finished_at = ?, error = ?
             WHERE token = ? AND stack_id = ?`,
    )
    .run([now, `Recovered after runtime reconciliation (${lifecycle})`, operationToken, stackId]);
  return { outcome: "recovered", stack: requireStack(database, stackId) };
};

const tombstoneStack = (
  database: ManagedSqliteDatabase,
  stackId: string,
  operationToken: string,
  now: string,
): ManagedStackRecord => {
  requireOwnedOperation(database, stackId, operationToken);
  requireStack(database, stackId);
  database.prepare("DELETE FROM ports WHERE stack_id = ?").run([stackId]);
  database
    .prepare(
      `UPDATE stacks SET
              status = 'tombstoned', lifecycle = 'stopped',
              runtime_metadata_json = ?, updated_at = ?, tombstoned_at = ?
             WHERE id = ?`,
    )
    .run([JSON.stringify({ processIds: {}, containerIds: {} }), now, now, stackId]);
  return requireStack(database, stackId);
};

const selectCheckoutLocations = (
  database: ManagedSqliteDatabase,
): ReadonlyArray<ManagedCheckoutLocation> =>
  database
    .prepare("SELECT * FROM checkout_locations ORDER BY canonical_path")
    .all()
    .map(
      (row): ManagedCheckoutLocation => ({
        id: getString(row, "id"),
        checkoutId: getString(row, "checkout_id"),
        canonicalPath: getString(row, "canonical_path"),
        lastSeenAt: getString(row, "last_seen_at"),
      }),
    );

const pruneCheckoutLocations = (
  database: ManagedSqliteDatabase,
  locationIds: ReadonlyArray<string>,
): number => {
  let removed = 0;
  const statement = database.prepare("DELETE FROM checkout_locations WHERE id = ?");
  for (const id of new Set(locationIds)) {
    const existing = database.prepare("SELECT id FROM checkout_locations WHERE id = ?").get([id]);
    if (existing !== undefined) {
      statement.run([id]);
      removed += 1;
    }
  }
  return removed;
};

/**
 * The owner pid is validated before the transaction opens: it is the caller's
 * own input, not a decision about persisted state, and a value recovery could
 * never probe must not even begin a write.
 */
const requireOwnerPid = (
  ownerPid: number | undefined,
): Effect.Effect<void, InvalidManagedOwnerPidError> =>
  Effect.try({
    try: () => {
      assertManagedOwnerPid(ownerPid);
    },
    catch: failsWith<InvalidManagedOwnerPidError>(InvalidManagedOwnerPidError),
  });

/**
 * Binds the registry contract to an open SQLite handle.
 *
 * The schema is initialized as part of building the repository, so a registry
 * written by an unsupported version fails here rather than at the first query.
 * Closing the handle belongs to the layer that opened it — see
 * {@link sqliteManagedStackRepositoryLayer} — so the contract has no `close`
 * method for a caller to forget.
 */
const createSqliteManagedStackRepository = (
  database: ManagedSqliteDatabase,
): Effect.Effect<ManagedStackRepositoryShape, UnsupportedManagedRegistryVersionError> =>
  Effect.gen(function* () {
    yield* initializeRegistry(database);

    return {
      prepareOrdinaryStack: (input) =>
        Effect.flatMap(requireOwnerPid(input.ownerPid), () =>
          transaction(
            database,
            () => prepareOrdinaryStack(database, input),
            failsWith<PrepareOrdinaryStackFailure>(
              DuplicateManagedIdentityError,
              DuplicateManagedPortKeyError,
              InvalidManagedPortError,
              ManagedOperationOwnershipError,
              ManagedPortReservationError,
              ManagedStackNotFoundError,
            ),
          ),
        ),
      publishPendingStack: (stackId, operationToken, now) =>
        transaction(
          database,
          () => publishPendingStack(database, stackId, operationToken, now),
          failsWith<OwnedManagedStackFailure>(
            ManagedOperationOwnershipError,
            ManagedStackNotFoundError,
          ),
        ),
      abortPendingStack: (stackId, operationToken) =>
        transaction(
          database,
          () => abortPendingStack(database, stackId, operationToken),
          failsWith<OwnedManagedStackFailure>(
            ManagedOperationOwnershipError,
            ManagedStackNotFoundError,
          ),
        ),
      getStack: (stackId) => readTransaction(database, () => getStack(database, stackId)),
      listStacks: (options) => readTransaction(database, () => selectStacks(database, options)),
      claimOperation: (input) =>
        Effect.flatMap(requireOwnerPid(input.ownerPid), () =>
          transaction(
            database,
            () => claimOperation(database, input),
            failsWith<ClaimManagedOperationFailure>(
              ManagedOperationOwnershipError,
              ManagedStackNotFoundError,
            ),
          ),
        ),
      finishOperation: (stackId, operationToken, outcome, now, error) =>
        transaction(
          database,
          () => finishOperation(database, stackId, operationToken, outcome, now, error),
          failsWith<ManagedOperationOwnershipError>(ManagedOperationOwnershipError),
        ),
      updateStack: (input) =>
        transaction(
          database,
          () => updateStack(database, input),
          failsWith<UpdateManagedStackFailure>(
            DuplicateManagedPortKeyError,
            InvalidManagedPortError,
            ManagedOperationOwnershipError,
            ManagedPendingStackUpdateError,
            ManagedPortReservationError,
            ManagedRunningStackPortChangeError,
            ManagedStackNotFoundError,
          ),
        ),
      listActiveOperations: (startedBefore) =>
        Effect.sync(() => selectActiveOperations(database, startedBefore)),
      reconcileOperation: (stackId, operationToken, lifecycle, now) =>
        transaction(
          database,
          () => reconcileOperation(database, stackId, operationToken, lifecycle, now),
          failsWith<ReconcileManagedOperationFailure>(
            DuplicateManagedPortKeyError,
            InvalidManagedPortError,
            ManagedOperationOwnershipError,
            ManagedPortReservationError,
            ManagedStackNotFoundError,
          ),
        ),
      tombstoneStack: (stackId, operationToken, now) =>
        transaction(
          database,
          () => tombstoneStack(database, stackId, operationToken, now),
          failsWith<OwnedManagedStackFailure>(
            ManagedOperationOwnershipError,
            ManagedStackNotFoundError,
          ),
        ),
      listCheckoutLocations: () => Effect.sync(() => selectCheckoutLocations(database)),
      pruneCheckoutLocations: (locationIds) =>
        transaction(database, () => pruneCheckoutLocations(database, locationIds), neverFails),
    };
  });

/**
 * The registry stores workspace paths, ports, and credential references that
 * other local users must not read. Pre-create the database file with an
 * owner-only mode so it never exists with umask-derived permissions, and
 * retighten both it and a directory left looser by an earlier build. Doing this
 * before the WAL conversion also makes the -wal/-shm sidecars inherit the
 * owner-only mode.
 */
export const hardenManagedRegistryFile = (path: string): void => {
  if (path === ":memory:") {
    return;
  }
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  chmodSync(dirname(path), 0o700);
  closeSync(openSync(path, "a", 0o600));
  chmodSync(path, 0o600);
};

/**
 * The registry as a scoped layer: the handle is opened when the layer is built
 * and closed when its scope closes, including when schema initialization refuses
 * the registry, so no failure path can leak an open database.
 *
 * Building this layer is I/O and may suspend: a cold start racing another
 * process' WAL conversion waits on a schedule before trying again, so the layer
 * must be built through a runner that can suspend rather than `Effect.runSync`.
 */
export const sqliteManagedStackRepositoryLayer = (
  openDatabase: () => ManagedSqliteDatabase,
): Layer.Layer<ManagedStackRepository, UnsupportedManagedRegistryVersionError> =>
  Layer.effect(
    ManagedStackRepository,
    Effect.gen(function* () {
      // Opening the handle and registering its close are one acquisition, so no
      // interruption can land between them and leak the open database.
      const database = yield* Effect.acquireRelease(Effect.sync(openDatabase), (open) =>
        Effect.sync(() => {
          open.close();
        }),
      );
      return yield* createSqliteManagedStackRepository(database);
    }),
  );
