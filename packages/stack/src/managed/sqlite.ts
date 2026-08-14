import { chmodSync, closeSync, mkdirSync, openSync } from "node:fs";
import { dirname } from "node:path";
import { Duration, Effect, Layer, Schedule, Schema } from "effect";
import {
  DuplicateManagedIdentityError,
  ManagedCheckoutConflictError,
  ManagedCopiedBranchConflictError,
  ManagedIdentityTransitionOwnershipError,
  ManagedInaccessiblePathError,
  DuplicateManagedPortKeyError,
  InvalidManagedOwnerPidError,
  InvalidManagedPortError,
  ManagedOperationOwnershipError,
  ManagedPendingStackUpdateError,
  ManagedPortReservationError,
  ManagedRunningStackPortChangeError,
  ManagedStackNotFoundError,
  type ManagedCheckoutKind,
  type ManagedCheckoutLocation,
  type ManagedIdentityClaims,
  type ManagedIdentityTransitionRecord,
  type ManagedIdentityTransitionKind,
  type ManagedIdentityTransitionPhase,
  type ManagedCheckoutLocationState,
  type ManagedCheckoutScopedContextKind,
  type ManagedContextKind,
  type ManagedContextRecord,
  type ManagedIdentityTriple,
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
  type ManagedStackProjection,
  type ManagedStackRecord,
  type ManagedStackStatus,
} from "./model.ts";
import type {
  ClaimManagedOperationFailure,
  ClaimManagedOperationInput,
  ClaimManagedOperationResult,
  ManagedStackRepositoryShape,
  OwnedManagedStackFailure,
  PrepareStackFailure,
  PrepareStackInput,
  PrepareStackResult,
  ReconcileManagedOperationFailure,
  ReconcileManagedOperationResult,
  UpdateManagedStackFailure,
  UpdateManagedStackInput,
  ApplyManagedCheckoutLocationInput,
  ManagedCheckoutLocationDecision,
  RefreshManagedContextOwnerInput,
  MigrateManagedContextToBranchInput,
  MigrateManagedContextToBranchFailure,
  ReserveManagedIdentityTransitionInput,
  AdvanceManagedIdentityTransitionInput,
  FinalizeManagedIdentityTransitionInput,
  AbandonManagedIdentityTransitionInput,
  PruneManagedIdentityMetadataInput,
  PruneManagedIdentityMetadataResult,
  ManagedIdentityRecoveryError,
  RegisterManagedCheckoutIdentityInput,
  ManagedCheckoutIdentityRegistration,
  ManagedCheckoutIdentityRegistrationFailure,
} from "./repository.ts";
import {
  assertManagedOwnerPid,
  assertManagedStackUpdatable,
  decideManagedContextRegistration,
  managedStackOccupiesPorts,
  ManagedStackRepository,
  reconcileManagedPortAssignments,
  validateManagedPortAssignments,
  decideManagedCheckoutLocation,
  decideManagedIdentityTransitionAdvance,
  decideManagedIdentityTransitionFinalize,
  decideManagedIdentityTransitionAbandon,
  decideManagedIdentityTransitionReservation,
  decideManagedContextOwnerRefresh,
  decideManagedContextToBranch,
  decideManagedIdentityMetadataPrune,
  transitionResourceKeys,
  decideManagedCheckoutIdentity,
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

const getCheckoutKind = (row: unknown): ManagedCheckoutKind => {
  const kind = getString(row, "kind");
  if (
    kind === "bare-worktree" ||
    kind === "git" ||
    kind === "linked-worktree" ||
    kind === "ordinary"
  ) {
    return kind;
  }
  throw new Error(`SQLite row has invalid checkout kind ${kind}`);
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

const managedCheckoutKind = (value: string): ManagedCheckoutKind => {
  if (
    value === "bare-worktree" ||
    value === "git" ||
    value === "linked-worktree" ||
    value === "ordinary"
  ) {
    return value;
  }
  throw new Error(`Unknown managed checkout kind ${value}`);
};

const managedContextKind = (value: string): ManagedContextKind => {
  if (value === "branch" || value === "detached" || value === "workspace") {
    return value;
  }
  throw new Error(`Unknown managed context kind ${value}`);
};

const managedPortIntent = (value: string): ManagedPortIntent => {
  if (value === "automatic" || value === "exact") {
    return value;
  }
  throw new Error(`Unknown managed port intent ${value}`);
};

const managedCheckoutLocationState = (value: string): ManagedCheckoutLocationState => {
  if (value === "active" || value === "blocked" || value === "superseded") return value;
  throw new Error(`Unknown managed checkout location state ${value}`);
};

const managedIdentityTransitionPhase = (value: string): ManagedIdentityTransitionPhase => {
  if (value === "reserved" || value === "git-written" || value === "finalized") return value;
  throw new Error(`Unknown managed identity transition phase ${value}`);
};

const managedIdentityTransitionKind = (value: string): ManagedIdentityTransitionKind => {
  if (
    value === "adopt-checkout" ||
    value === "adopt-context" ||
    value === "branch-copy" ||
    value === "folder-to-git" ||
    value === "new-checkout" ||
    value === "rebind-checkout"
  )
    return value;
  throw new Error(`Unknown managed identity transition kind ${value}`);
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

const commitPreservingCause = (database: ManagedSqliteDatabase): void => {
  try {
    database.exec("COMMIT");
  } catch (error: unknown) {
    rollbackPreservingCause(database);
    throw error;
  }
};

/** The handles currently between `BEGIN` and `COMMIT` — see {@link runTransaction}. */
const openTransactions = new WeakSet<ManagedSqliteDatabase>();

/**
 * `BEGIN`, the decision's statements, and `COMMIT` as one synchronous block.
 *
 * Atomicity here rests on the drivers being synchronous and the handle being
 * single-threaded: nothing else can run between the statements, so a partially
 * applied decision is never observable. That only holds while the whole block is
 * one JavaScript turn — splitting the boundary across effects would reintroduce
 * a suspension point where the fiber scheduler could preempt at its operation
 * budget and let another fiber `BEGIN` on this very handle.
 *
 * What synchrony cannot rule out is a decision that re-enters the repository:
 * SQLite has no nested transactions, so the inner `BEGIN` would refuse with a
 * driver message about the outer one, and unwinding the inner attempt would
 * `ROLLBACK` the outer transaction's writes. Reentrancy is a bug in the calling
 * code rather than a condition to recover from, so it is refused here — before
 * any statement runs, and without touching the transaction already in flight.
 */
const runTransaction = <A>(
  database: ManagedSqliteDatabase,
  begin: "BEGIN" | "BEGIN IMMEDIATE",
  run: () => A,
): A => {
  if (openTransactions.has(database)) {
    throw new Error("A registry transaction is already open on this database handle");
  }
  database.exec(begin);
  openTransactions.add(database);
  try {
    let decided: A;
    try {
      decided = run();
    } catch (error: unknown) {
      rollbackPreservingCause(database);
      throw error;
    }
    commitPreservingCause(database);
    return decided;
  } finally {
    openTransactions.delete(database);
  }
};

/**
 * Creates the current registry schema directly on a fresh database handle.
 * This package is unreleased, so there is no historical schema to migrate or
 * version marker to maintain.
 */
const createSchema = (database: ManagedSqliteDatabase): void =>
  runTransaction(database, "BEGIN IMMEDIATE", () => {
    const requiredObjects = [
      "projects",
      "checkouts",
      "checkout_locations",
      "one_active_location_per_checkout",
      "one_active_location_per_path",
      "contexts",
      "one_checkout_scoped_context_per_kind",
      "identity_transitions",
      "stacks",
      "one_live_stack_per_identity",
      "ports",
      "port_assignments_by_port",
      "operations",
      "one_active_operation_per_stack",
    ] as const;
    const existingObjects = new Set(
      database
        .prepare(
          `SELECT name FROM sqlite_master
           WHERE name IN (${requiredObjects.map(() => "?").join(", ")})`,
        )
        .all(requiredObjects)
        .map((row) => getString(row, "name")),
    );
    if (existingObjects.size === requiredObjects.length) {
      return;
    }
    if (existingObjects.size !== 0) {
      throw new Error("Managed registry schema is incomplete");
    }
    database.exec(`
      CREATE TABLE projects (
        id TEXT PRIMARY KEY,
        created_at TEXT NOT NULL
      );

      CREATE TABLE checkouts (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id),
        kind TEXT NOT NULL CHECK (kind IN ('git', 'linked-worktree', 'bare-worktree', 'ordinary')),
        created_at TEXT NOT NULL
      );

      CREATE TABLE checkout_locations (
        id TEXT PRIMARY KEY,
        checkout_id TEXT NOT NULL REFERENCES checkouts(id),
        canonical_path TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('active', 'blocked', 'superseded')),
        rebound_from_location_id TEXT REFERENCES checkout_locations(id),
        last_seen_at TEXT NOT NULL
      );
      CREATE UNIQUE INDEX one_active_location_per_checkout
        ON checkout_locations(checkout_id) WHERE state = 'active';
      CREATE UNIQUE INDEX one_active_location_per_path
        ON checkout_locations(canonical_path) WHERE state = 'active';

      CREATE TABLE contexts (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id),
        checkout_id TEXT REFERENCES checkouts(id),
        kind TEXT NOT NULL CHECK (kind IN ('branch', 'detached', 'workspace')),
        locator TEXT,
        owner_branch TEXT,
        created_at TEXT NOT NULL,
        -- A branch is shared by every checkout of the repository, so its context
        -- is project-scoped; the other two kinds belong to one checkout each.
        CHECK (
          (kind = 'branch' AND checkout_id IS NULL)
          OR (kind != 'branch' AND checkout_id IS NOT NULL)
        )
      );
      CREATE UNIQUE INDEX one_checkout_scoped_context_per_kind
        ON contexts(checkout_id, kind)
        WHERE kind IN ('detached', 'workspace');

      CREATE TABLE identity_transitions (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL CHECK (kind IN ('adopt-checkout', 'adopt-context', 'branch-copy', 'folder-to-git', 'new-checkout', 'rebind-checkout')),
        phase TEXT NOT NULL CHECK (phase IN ('reserved', 'git-written', 'finalized')),
        project_id TEXT,
        checkout_id TEXT,
        context_id TEXT,
        branch TEXT,
        path TEXT,
        expected_git_value TEXT,
        target_git_value TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
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

    `);
  });

type ManagedSqliteIndexShape = {
  readonly table: string;
  readonly columns: ReadonlyArray<string>;
  readonly unique: boolean;
  readonly predicate?: string;
};

const managedSqliteTableColumns: Readonly<Record<string, ReadonlyArray<string>>> = {
  projects: ["id", "created_at"],
  checkouts: ["id", "project_id", "kind", "created_at"],
  checkout_locations: [
    "id",
    "checkout_id",
    "canonical_path",
    "state",
    "rebound_from_location_id",
    "last_seen_at",
  ],
  contexts: ["id", "project_id", "checkout_id", "kind", "locator", "owner_branch", "created_at"],
  identity_transitions: [
    "id",
    "kind",
    "phase",
    "project_id",
    "checkout_id",
    "context_id",
    "branch",
    "path",
    "expected_git_value",
    "target_git_value",
    "created_at",
    "updated_at",
  ],
  stacks: [
    "id",
    "project_id",
    "checkout_id",
    "context_id",
    "name",
    "status",
    "lifecycle",
    "runtime_request",
    "runtime",
    "root_path",
    "data_path",
    "logs_path",
    "runtime_path",
    "config_fingerprint",
    "credentials_reference",
    "service_versions_json",
    "runtime_metadata_json",
    "created_at",
    "updated_at",
    "tombstoned_at",
  ],
  ports: ["stack_id", "key", "port", "intent"],
  operations: [
    "token",
    "stack_id",
    "kind",
    "status",
    "owner_pid",
    "started_at",
    "finished_at",
    "error",
  ],
};

const managedSqliteIndexShapes: Readonly<Record<string, ManagedSqliteIndexShape>> = {
  one_active_location_per_checkout: {
    table: "checkout_locations",
    columns: ["checkout_id"],
    unique: true,
    predicate: "state = 'active'",
  },
  one_active_location_per_path: {
    table: "checkout_locations",
    columns: ["canonical_path"],
    unique: true,
    predicate: "state = 'active'",
  },
  one_checkout_scoped_context_per_kind: {
    table: "contexts",
    columns: ["checkout_id", "kind"],
    unique: true,
    predicate: "kind IN ('detached', 'workspace')",
  },
  one_live_stack_per_identity: {
    table: "stacks",
    columns: ["checkout_id", "context_id", "name"],
    unique: true,
    predicate: "status != 'tombstoned'",
  },
  port_assignments_by_port: {
    table: "ports",
    columns: ["port"],
    unique: false,
  },
  one_active_operation_per_stack: {
    table: "operations",
    columns: ["stack_id"],
    unique: true,
    predicate: "status = 'active'",
  },
};

const normalizeSql = (sql: string): string =>
  sql
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/\s*([(),=<>!])\s*/g, "$1")
    .replace(/;$/, "")
    .trim();

const sqliteSchemaError = (message: string): Error =>
  new Error(`Managed registry schema is incompatible: ${message}`);

/**
 * Checks the current schema's load-bearing shape when opening an existing
 * registry. Object names alone are insufficient: a hand-edited or partially
 * created database can retain every expected name while dropping a column or
 * changing a partial uniqueness invariant.
 */
const validateCurrentSchema = (database: ManagedSqliteDatabase): void => {
  for (const [table, requiredColumns] of Object.entries(managedSqliteTableColumns)) {
    const columns = new Set(
      database
        .prepare(`PRAGMA table_info(${table})`)
        .all()
        .map((row) => getString(row, "name")),
    );
    for (const column of requiredColumns) {
      if (!columns.has(column)) {
        throw sqliteSchemaError(`table ${table} is missing column ${column}`);
      }
    }
  }

  for (const [indexName, shape] of Object.entries(managedSqliteIndexShapes)) {
    const index = database
      .prepare(`PRAGMA index_list(${shape.table})`)
      .all()
      .find((row) => getString(row, "name") === indexName);
    if (index === undefined) {
      throw sqliteSchemaError(`index ${indexName} is missing`);
    }
    const unique = getNumber(index, "unique") === 1;
    if (unique !== shape.unique) {
      throw sqliteSchemaError(`index ${indexName} has the wrong uniqueness`);
    }
    if (shape.predicate !== undefined && getNumber(index, "partial") !== 1) {
      throw sqliteSchemaError(`index ${indexName} is missing its partial predicate`);
    }
    if (shape.predicate === undefined && getNumber(index, "partial") !== 0) {
      throw sqliteSchemaError(`index ${indexName} unexpectedly has a partial predicate`);
    }

    const columns = [...database.prepare(`PRAGMA index_info(${indexName})`).all()]
      .sort((left: unknown, right: unknown) => getNumber(left, "seqno") - getNumber(right, "seqno"))
      .map((row: unknown) => getString(row, "name"));
    if (
      columns.length !== shape.columns.length ||
      columns.some((column, position) => column !== shape.columns[position])
    ) {
      throw sqliteSchemaError(
        `index ${indexName} has columns ${JSON.stringify(columns)} instead of ${JSON.stringify(shape.columns)}`,
      );
    }

    if (shape.predicate !== undefined) {
      const sqlRow = database
        .prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = ?")
        .get([indexName]);
      const sql = getString(sqlRow, "sql");
      const normalized = normalizeSql(sql);
      const where = normalized.match(/\bwhere\b(.+)$/)?.[1]?.trim();
      if (where !== normalizeSql(shape.predicate)) {
        throw sqliteSchemaError(`index ${indexName} has the wrong partial predicate`);
      }
    }
  }
};

/**
 * Prepares a freshly opened handle for use as the registry.
 *
 * `busy_timeout` is set first so every later statement waits out a writer on its
 * own, then the file is converted to WAL, and only then is the current schema
 * created directly. Driver errors stay defects so actual SQLite corruption/open
 * failures remain visible to callers.
 */
const initializeRegistry = (database: ManagedSqliteDatabase): Effect.Effect<void> =>
  Effect.gen(function* () {
    yield* Effect.sync(() => {
      database.exec("PRAGMA busy_timeout = 5000");
      database.exec("PRAGMA foreign_keys = ON");
    });
    yield* enableWriteAheadLogging(database);
    yield* Effect.sync(() => {
      createSchema(database);
      validateCurrentSchema(database);
    });
  });

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

const decodeStackProjectionWithPorts = (
  row: unknown,
  ports: ReadonlyArray<ManagedPortAssignment>,
): ManagedStackProjection => ({
  ...decodeStackWithPorts(row, ports),
  checkoutKind: managedCheckoutKind(getString(row, "checkout_kind")),
  canonicalPath: getOptionalString(row, "canonical_path"),
  contextKind: managedContextKind(getString(row, "context_kind")),
  contextLocator: getOptionalString(row, "context_locator"),
});

/**
 * The reader's view of the stacks table. `checkout_locations` is joined loosely
 * because a location can be pruned out from under a stack that still exists,
 * which leaves the canonical path unknown rather than the stack unlistable.
 */
const STACK_PROJECTION_SELECT = `SELECT stacks.*,
            checkouts.kind AS checkout_kind,
            contexts.kind AS context_kind,
            contexts.locator AS context_locator,
            checkout_locations.canonical_path AS canonical_path
         FROM stacks
         JOIN checkouts ON checkouts.id = stacks.checkout_id
         JOIN contexts ON contexts.id = stacks.context_id
         LEFT JOIN checkout_locations ON checkout_locations.checkout_id = stacks.checkout_id
              AND checkout_locations.state = 'active'`;

const getStackProjection = (
  database: ManagedSqliteDatabase,
  stackId: string,
): ManagedStackProjection | undefined => {
  const row = database.prepare(`${STACK_PROJECTION_SELECT} WHERE stacks.id = ?`).get([stackId]);
  return row === undefined
    ? undefined
    : decodeStackProjectionWithPorts(row, queryPorts(database, stackId));
};

const selectStackProjections = (
  database: ManagedSqliteDatabase,
  options?: { readonly includeTombstoned?: boolean },
): ReadonlyArray<ManagedStackProjection> => {
  const order = "ORDER BY stacks.created_at, stacks.id";
  const rows =
    options?.includeTombstoned === true
      ? database.prepare(`${STACK_PROJECTION_SELECT} ${order}`).all()
      : database
          .prepare(`${STACK_PROJECTION_SELECT} WHERE stacks.status != 'tombstoned' ${order}`)
          .all();
  const portsByStack = queryPortsByStack(
    database,
    rows.map((row) => getString(row, "id")),
  );
  return rows.map((row) =>
    decodeStackProjectionWithPorts(row, portsByStack.get(getString(row, "id")) ?? []),
  );
};

const selectStackProjectionsByIdentity = (
  database: ManagedSqliteDatabase,
  identity: ManagedIdentityTriple,
  options?: { readonly includeTombstoned?: boolean },
): ReadonlyArray<ManagedStackProjection> => {
  const statusClause =
    options?.includeTombstoned === true ? "" : " AND stacks.status != 'tombstoned'";
  const rows = database
    .prepare(
      `${STACK_PROJECTION_SELECT}
       WHERE stacks.project_id = ? AND stacks.checkout_id = ? AND stacks.context_id = ?${statusClause}
       ORDER BY stacks.created_at, stacks.id`,
    )
    .all([identity.projectId, identity.checkoutId, identity.contextId]);
  const portsByStack = queryPortsByStack(
    database,
    rows.map((row) => getString(row, "id")),
  );
  return rows.map((row) =>
    decodeStackProjectionWithPorts(row, portsByStack.get(getString(row, "id")) ?? []),
  );
};

const decodeContext = (row: unknown): ManagedContextRecord => ({
  id: getString(row, "id"),
  projectId: getString(row, "project_id"),
  checkoutId: getOptionalString(row, "checkout_id"),
  kind: managedContextKind(getString(row, "kind")),
  locator: getOptionalString(row, "locator"),
  ownerBranch: getOptionalString(row, "owner_branch"),
  createdAt: getString(row, "created_at"),
});

const decodeCheckoutLocation = (row: unknown): ManagedCheckoutLocation => ({
  id: getString(row, "id"),
  checkoutId: getString(row, "checkout_id"),
  canonicalPath: getString(row, "canonical_path"),
  state: managedCheckoutLocationState(getString(row, "state")),
  reboundFromLocationId: getOptionalString(row, "rebound_from_location_id"),
  lastSeenAt: getString(row, "last_seen_at"),
});

const decodeIdentityTransition = (row: unknown): ManagedIdentityTransitionRecord => ({
  id: getString(row, "id"),
  kind: managedIdentityTransitionKind(getString(row, "kind")),
  phase: managedIdentityTransitionPhase(getString(row, "phase")),
  projectId: getOptionalString(row, "project_id"),
  checkoutId: getOptionalString(row, "checkout_id"),
  contextId: getOptionalString(row, "context_id"),
  branch: getOptionalString(row, "branch"),
  path: getOptionalString(row, "path"),
  expectedGitValue: getOptionalString(row, "expected_git_value"),
  targetGitValue: getOptionalString(row, "target_git_value"),
  createdAt: getString(row, "created_at"),
  updatedAt: getString(row, "updated_at"),
});

const findCheckoutContext = (
  database: ManagedSqliteDatabase,
  checkoutId: string,
  kind: ManagedCheckoutScopedContextKind,
): ManagedContextRecord | undefined => {
  const row = database
    .prepare("SELECT * FROM contexts WHERE checkout_id = ? AND kind = ?")
    .get([checkoutId, kind]);
  return row === undefined ? undefined : decodeContext(row);
};

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
  input: PrepareStackInput,
  contextId: string,
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
      contextId,
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

/**
 * Registers the context the caller resolved and answers with the context the
 * stack must actually use.
 *
 * A branch context's ID comes from git config, which is authoritative: the row
 * adopts it, and only the branch name it is displayed under is refreshed when git
 * has renamed the branch since. A checkout-scoped context is minted by whoever
 * gets there first, so an existing row for that checkout and kind wins over the
 * ID this caller brought — that is what makes two concurrent starts on one
 * detached `HEAD` converge on a single context instead of splitting.
 */
const registerContext = (database: ManagedSqliteDatabase, input: PrepareStackInput): string => {
  const requestedExistingRow = database
    .prepare("SELECT * FROM contexts WHERE id = ?")
    .get([input.identity.contextId]);
  const requestedExisting =
    requestedExistingRow === undefined ? undefined : decodeContext(requestedExistingRow);
  const checkoutScopedExisting =
    input.context.kind === "branch"
      ? undefined
      : findCheckoutContext(database, input.identity.checkoutId, input.context.kind);
  const decision = decideManagedContextRegistration({
    requestedId: input.identity.contextId,
    projectId: input.identity.projectId,
    checkoutId: input.identity.checkoutId,
    context: input.context,
    now: input.now,
    checkoutScopedExisting,
    requestedExisting,
  });
  if (decision.outcome === "existing") {
    if (decision.refreshLocator !== undefined) {
      database
        .prepare("UPDATE contexts SET locator = ? WHERE id = ?")
        .run([decision.refreshLocator, decision.contextId]);
    }
    return decision.contextId;
  }
  database
    .prepare(
      `INSERT INTO contexts (id, project_id, checkout_id, kind, locator, owner_branch, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run([
      decision.context.id,
      decision.context.projectId,
      decision.context.checkoutId ?? null,
      decision.context.kind,
      decision.context.locator ?? null,
      decision.context.ownerBranch ?? null,
      decision.context.createdAt,
    ]);
  return decision.context.id;
};

const registerCheckoutIdentity = (
  database: ManagedSqliteDatabase,
  input: RegisterManagedCheckoutIdentityInput,
): ManagedCheckoutIdentityRegistration => {
  database
    .prepare("INSERT OR IGNORE INTO projects (id, created_at) VALUES (?, ?)")
    .run([input.identity.projectId, input.now]);
  const checkoutRow = database
    .prepare("SELECT project_id, kind FROM checkouts WHERE id = ?")
    .get([input.identity.checkoutId]);
  const existingCheckout =
    checkoutRow === undefined
      ? undefined
      : {
          projectId: getString(checkoutRow, "project_id"),
          kind: getCheckoutKind(checkoutRow),
        };
  const requestedExistingRow = database
    .prepare("SELECT * FROM contexts WHERE id = ?")
    .get([input.identity.contextId]);
  const requestedExisting =
    requestedExistingRow === undefined ? undefined : decodeContext(requestedExistingRow);
  const checkoutScopedExisting =
    input.context.kind === "branch"
      ? undefined
      : findCheckoutContext(database, input.identity.checkoutId, input.context.kind);
  const decision = decideManagedCheckoutIdentity({
    requested: input,
    existingCheckout,
    checkoutLocations: selectCheckoutLocations(database),
    checkoutScopedExisting,
    requestedExisting,
  });
  database
    .prepare(
      `INSERT INTO checkouts (id, project_id, kind, created_at) VALUES (?, ?, ?, ?)
             ON CONFLICT (id) DO UPDATE SET kind = excluded.kind`,
    )
    .run([input.identity.checkoutId, input.identity.projectId, input.checkoutKind, input.now]);
  const contextRow = database
    .prepare("SELECT id FROM contexts WHERE id = ?")
    .get([decision.registration.context.id]);
  if (contextRow === undefined) {
    database
      .prepare(
        `INSERT INTO contexts (id, project_id, checkout_id, kind, locator, owner_branch, created_at)
               VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run([
        decision.registration.context.id,
        decision.registration.context.projectId,
        decision.registration.context.checkoutId ?? null,
        decision.registration.context.kind,
        decision.registration.context.locator ?? null,
        decision.registration.context.ownerBranch ?? null,
        decision.registration.context.createdAt,
      ]);
  } else {
    database
      .prepare("UPDATE contexts SET locator = ? WHERE id = ?")
      .run([decision.registration.context.locator ?? null, decision.registration.context.id]);
  }
  for (const updated of decision.locationDecision.updates ?? []) {
    database
      .prepare("UPDATE checkout_locations SET state = ?, last_seen_at = ? WHERE id = ?")
      .run([updated.state, updated.lastSeenAt, updated.id]);
  }
  const locationRow = database
    .prepare("SELECT id FROM checkout_locations WHERE id = ?")
    .get([decision.registration.location.id]);
  if (locationRow === undefined) {
    database
      .prepare(
        `INSERT INTO checkout_locations
                (id, checkout_id, canonical_path, state, rebound_from_location_id, last_seen_at)
               VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run([
        decision.registration.location.id,
        decision.registration.location.checkoutId,
        decision.registration.location.canonicalPath,
        decision.registration.location.state,
        decision.registration.location.reboundFromLocationId ?? null,
        decision.registration.location.lastSeenAt,
      ]);
  } else {
    database
      .prepare(
        "UPDATE checkout_locations SET state = ?, rebound_from_location_id = ?, last_seen_at = ? WHERE id = ?",
      )
      .run([
        decision.registration.location.state,
        decision.registration.location.reboundFromLocationId ?? null,
        decision.registration.location.lastSeenAt,
        decision.registration.location.id,
      ]);
  }
  return decision.registration;
};

const prepareStack = (
  database: ManagedSqliteDatabase,
  input: PrepareStackInput,
): PrepareStackResult => {
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
    .prepare(
      `INSERT INTO checkouts (id, project_id, kind, created_at) VALUES (?, ?, ?, ?)
             ON CONFLICT (id) DO UPDATE SET kind = excluded.kind`,
    )
    .run([input.identity.checkoutId, input.identity.projectId, input.checkoutKind, input.now]);

  const contextId = registerContext(database, input);

  const locationDecision = decideManagedCheckoutLocation({
    requested: {
      checkoutId: input.identity.checkoutId,
      locationId: input.locationId,
      canonicalPath: input.checkoutRootPath,
      now: input.now,
    },
    checkoutLocations: selectCheckoutLocations(database),
    checkoutExists: true,
  });
  if (locationDecision.outcome !== "active") {
    throw new ManagedCheckoutConflictError({
      checkoutId: input.identity.checkoutId,
      canonicalPath: input.checkoutRootPath,
    });
  }
  const existingLocation = database
    .prepare("SELECT id FROM checkout_locations WHERE id = ?")
    .get([locationDecision.location.id]);
  if (existingLocation === undefined) {
    database
      .prepare(
        `INSERT INTO checkout_locations
                (id, checkout_id, canonical_path, state, rebound_from_location_id, last_seen_at)
               VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run([
        locationDecision.location.id,
        locationDecision.location.checkoutId,
        locationDecision.location.canonicalPath,
        locationDecision.location.state,
        locationDecision.location.reboundFromLocationId ?? null,
        locationDecision.location.lastSeenAt,
      ]);
  } else {
    database
      .prepare("UPDATE checkout_locations SET last_seen_at = ? WHERE id = ?")
      .run([input.now, locationDecision.location.id]);
  }

  const existingRow = database
    .prepare(
      `SELECT * FROM stacks
             WHERE checkout_id = ? AND context_id = ? AND name = ? AND status != 'tombstoned'`,
    )
    .get([input.identity.checkoutId, contextId, input.stackName]);
  if (existingRow !== undefined) {
    const stack = decodeStack(database, existingRow);
    const operation = getActiveOperation(database, stack.id);
    return { outcome: "existing", stack, operation };
  }

  insertConfiguration(database, input, contextId);
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
    .map(decodeCheckoutLocation);

const selectIdentityTransitions = (
  database: ManagedSqliteDatabase,
): ReadonlyArray<ManagedIdentityTransitionRecord> =>
  database
    .prepare("SELECT * FROM identity_transitions ORDER BY created_at, id")
    .all()
    .map(decodeIdentityTransition);

const applyCheckoutLocation = (
  database: ManagedSqliteDatabase,
  input: ApplyManagedCheckoutLocationInput,
): ManagedCheckoutLocationDecision => {
  const checkout = database
    .prepare("SELECT id FROM checkouts WHERE id = ?")
    .get([input.checkoutId]);
  const existing = selectCheckoutLocations(database);
  const decision = decideManagedCheckoutLocation({
    requested: input,
    checkoutLocations: existing,
    checkoutExists: checkout !== undefined,
  });
  for (const updated of decision.updates ?? []) {
    database
      .prepare("UPDATE checkout_locations SET state = ?, last_seen_at = ? WHERE id = ?")
      .run([updated.state, updated.lastSeenAt, updated.id]);
  }
  {
    const found = database
      .prepare("SELECT id FROM checkout_locations WHERE id = ?")
      .get([decision.location.id]);
    if (found === undefined) {
      database
        .prepare(
          `INSERT INTO checkout_locations
             (id, checkout_id, canonical_path, state, rebound_from_location_id, last_seen_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run([
          decision.location.id,
          decision.location.checkoutId,
          decision.location.canonicalPath,
          decision.location.state,
          decision.location.reboundFromLocationId ?? null,
          decision.location.lastSeenAt,
        ]);
    } else {
      database
        .prepare(
          "UPDATE checkout_locations SET checkout_id = ?, canonical_path = ?, state = ?, rebound_from_location_id = ?, last_seen_at = ? WHERE id = ?",
        )
        .run([
          decision.location.checkoutId,
          decision.location.canonicalPath,
          decision.location.state,
          decision.location.reboundFromLocationId ?? null,
          decision.location.lastSeenAt,
          decision.location.id,
        ]);
    }
  }
  return decision;
};

const refreshContextOwner = (
  database: ManagedSqliteDatabase,
  input: RefreshManagedContextOwnerInput,
): ManagedContextRecord => {
  const row = database.prepare("SELECT * FROM contexts WHERE id = ?").get([input.contextId]);
  const next = decideManagedContextOwnerRefresh({
    existing: row === undefined ? undefined : decodeContext(row),
    requested: input,
  });
  database
    .prepare("UPDATE contexts SET owner_branch = ?, locator = ? WHERE id = ?")
    .run([next.ownerBranch ?? null, next.locator ?? null, next.id]);
  return next;
};

const migrateContextToBranch = (
  database: ManagedSqliteDatabase,
  input: MigrateManagedContextToBranchInput,
): ManagedContextRecord => {
  const row = database.prepare("SELECT * FROM contexts WHERE id = ?").get([input.contextId]);
  const branchContexts = database
    .prepare("SELECT * FROM contexts WHERE project_id = ? AND kind = 'branch'")
    .all([input.projectId])
    .map(decodeContext);
  const existing = row === undefined ? undefined : decodeContext(row);
  const next = decideManagedContextToBranch({
    requested: input,
    existing,
    branchContexts,
  });
  if (
    existing !== undefined &&
    (existing.kind !== next.kind ||
      existing.projectId !== next.projectId ||
      existing.checkoutId !== next.checkoutId ||
      existing.locator !== next.locator ||
      existing.ownerBranch !== next.ownerBranch)
  ) {
    database
      .prepare(
        "UPDATE contexts SET checkout_id = ?, kind = ?, locator = ?, owner_branch = ? WHERE id = ?",
      )
      .run([
        next.checkoutId ?? null,
        next.kind,
        next.locator ?? null,
        next.ownerBranch ?? null,
        next.id,
      ]);
  }
  return next;
};

const reserveIdentityTransition = (
  database: ManagedSqliteDatabase,
  input: ReserveManagedIdentityTransitionInput,
): ManagedIdentityTransitionRecord => {
  const row = database.prepare("SELECT * FROM identity_transitions WHERE id = ?").get([input.id]);
  const existing = row === undefined ? undefined : decodeIdentityTransition(row);
  const resourceRows = database
    .prepare("SELECT * FROM identity_transitions WHERE phase != 'finalized'")
    .all()
    .map(decodeIdentityTransition);
  const requestedKeys = transitionResourceKeys(input);
  const resourceOwner = resourceRows.find((candidate) =>
    transitionResourceKeys(candidate).some((key) => requestedKeys.includes(key)),
  );
  const next = decideManagedIdentityTransitionReservation({
    requested: input,
    existing,
    resourceOwner,
  });
  if (existing === undefined) {
    database
      .prepare(
        `INSERT INTO identity_transitions
          (id, kind, phase, project_id, checkout_id, context_id, branch, path,
           expected_git_value, target_git_value, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run([
        next.id,
        next.kind,
        next.phase,
        next.projectId ?? null,
        next.checkoutId ?? null,
        next.contextId ?? null,
        next.branch ?? null,
        next.path ?? null,
        next.expectedGitValue ?? null,
        next.targetGitValue ?? null,
        next.createdAt,
        next.updatedAt,
      ]);
  }
  return next;
};

const advanceIdentityTransition = (
  database: ManagedSqliteDatabase,
  input: AdvanceManagedIdentityTransitionInput,
): ManagedIdentityTransitionRecord => {
  const row = database.prepare("SELECT * FROM identity_transitions WHERE id = ?").get([input.id]);
  if (row === undefined)
    throw new ManagedIdentityTransitionOwnershipError({ transitionId: input.id });
  const next = decideManagedIdentityTransitionAdvance(decodeIdentityTransition(row), input);
  database
    .prepare("UPDATE identity_transitions SET phase = ?, updated_at = ? WHERE id = ?")
    .run([next.phase, next.updatedAt, next.id]);
  return next;
};

const finalizeIdentityTransition = (
  database: ManagedSqliteDatabase,
  input: FinalizeManagedIdentityTransitionInput,
): ManagedIdentityTransitionRecord => {
  const row = database.prepare("SELECT * FROM identity_transitions WHERE id = ?").get([input.id]);
  if (row === undefined)
    throw new ManagedIdentityTransitionOwnershipError({ transitionId: input.id });
  const next = decideManagedIdentityTransitionFinalize(decodeIdentityTransition(row), input);
  database
    .prepare("UPDATE identity_transitions SET phase = ?, updated_at = ? WHERE id = ?")
    .run([next.phase, next.updatedAt, next.id]);
  return next;
};

const abandonIdentityTransition = (
  database: ManagedSqliteDatabase,
  input: AbandonManagedIdentityTransitionInput,
) => {
  const row = database.prepare("SELECT * FROM identity_transitions WHERE id = ?").get([input.id]);
  const decision = decideManagedIdentityTransitionAbandon(
    row === undefined ? undefined : decodeIdentityTransition(row),
    input,
  );
  if (decision.outcome === "abandoned") {
    database
      .prepare("DELETE FROM identity_transitions WHERE id = ? AND phase = 'reserved'")
      .run([input.id]);
  }
  return decision;
};

const pruneIdentityMetadata = (
  database: ManagedSqliteDatabase,
  input: PruneManagedIdentityMetadataInput,
): PruneManagedIdentityMetadataResult => {
  const locations = selectCheckoutLocations(database);
  const decision = decideManagedIdentityMetadataPrune({
    locations,
    locationIds: input.locationIds,
    transitions: selectIdentityTransitions(database),
  });
  const statement = database.prepare("DELETE FROM checkout_locations WHERE id = ?");
  for (const id of decision.prunedRecordIds) statement.run([id]);
  return decision;
};

const listIdentityClaims = (
  database: ManagedSqliteDatabase,
  projectId?: string,
): ManagedIdentityClaims => {
  const checkoutRows =
    projectId === undefined
      ? database.prepare("SELECT id, project_id FROM checkouts ORDER BY id").all()
      : database
          .prepare("SELECT id, project_id FROM checkouts WHERE project_id = ? ORDER BY id")
          .all([projectId]);
  const locationRows =
    projectId === undefined
      ? database.prepare("SELECT * FROM checkout_locations ORDER BY canonical_path").all()
      : database
          .prepare(
            `SELECT checkout_locations.*
             FROM checkout_locations
             INNER JOIN checkouts ON checkouts.id = checkout_locations.checkout_id
             WHERE checkouts.project_id = ?
             ORDER BY checkout_locations.canonical_path`,
          )
          .all([projectId]);
  const locations = locationRows.map(decodeCheckoutLocation);
  const contextRows =
    projectId === undefined
      ? database.prepare("SELECT * FROM contexts ORDER BY id").all()
      : database
          .prepare("SELECT * FROM contexts WHERE project_id = ? ORDER BY id")
          .all([projectId]);
  const transitionRows =
    projectId === undefined
      ? database.prepare("SELECT * FROM identity_transitions ORDER BY created_at, id").all()
      : database
          .prepare(
            `SELECT * FROM identity_transitions
             WHERE project_id = ?
                OR checkout_id IN (SELECT id FROM checkouts WHERE project_id = ?)
                OR context_id IN (SELECT id FROM contexts WHERE project_id = ?)
             ORDER BY created_at, id`,
          )
          .all([projectId, projectId, projectId]);
  return {
    checkoutProjects: checkoutRows.map((row) => ({
      checkoutId: getString(row, "id"),
      projectId: getString(row, "project_id"),
    })),
    locations,
    contexts: contextRows.map(decodeContext),
    transitions: transitionRows.map(decodeIdentityTransition),
  };
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
): Effect.Effect<ManagedStackRepositoryShape> =>
  Effect.gen(function* () {
    yield* initializeRegistry(database);

    return {
      registerCheckoutIdentity: (input) =>
        transaction(
          database,
          () => registerCheckoutIdentity(database, input),
          failsWith<ManagedCheckoutIdentityRegistrationFailure>(
            DuplicateManagedIdentityError,
            ManagedCheckoutConflictError,
            ManagedInaccessiblePathError,
          ),
        ),
      listIdentityClaims: (projectId) =>
        readTransaction(database, () => listIdentityClaims(database, projectId)),
      applyCheckoutLocation: (input) =>
        transaction(
          database,
          () => applyCheckoutLocation(database, input),
          failsWith<ManagedIdentityRecoveryError>(
            ManagedCheckoutConflictError,
            ManagedCopiedBranchConflictError,
            ManagedIdentityTransitionOwnershipError,
            ManagedInaccessiblePathError,
          ),
        ),
      refreshContextOwner: (input) =>
        transaction(
          database,
          () => refreshContextOwner(database, input),
          failsWith<ManagedIdentityRecoveryError>(ManagedCopiedBranchConflictError),
        ),
      migrateContextToBranch: (input) =>
        transaction(
          database,
          () => migrateContextToBranch(database, input),
          failsWith<MigrateManagedContextToBranchFailure>(
            DuplicateManagedIdentityError,
            ManagedCopiedBranchConflictError,
          ),
        ),
      reserveIdentityTransition: (input) =>
        transaction(
          database,
          () => reserveIdentityTransition(database, input),
          failsWith<ManagedIdentityRecoveryError>(ManagedIdentityTransitionOwnershipError),
        ),
      advanceIdentityTransition: (input) =>
        transaction(
          database,
          () => advanceIdentityTransition(database, input),
          failsWith<ManagedIdentityRecoveryError>(ManagedIdentityTransitionOwnershipError),
        ),
      finalizeIdentityTransition: (input) =>
        transaction(
          database,
          () => finalizeIdentityTransition(database, input),
          failsWith<ManagedIdentityRecoveryError>(ManagedIdentityTransitionOwnershipError),
        ),
      prepareStack: (input) =>
        Effect.flatMap(requireOwnerPid(input.ownerPid), () =>
          transaction(
            database,
            () => prepareStack(database, input),
            failsWith<PrepareStackFailure>(
              DuplicateManagedIdentityError,
              ManagedCheckoutConflictError,
              ManagedCopiedBranchConflictError,
              ManagedIdentityTransitionOwnershipError,
              ManagedInaccessiblePathError,
              DuplicateManagedPortKeyError,
              InvalidManagedPortError,
              ManagedOperationOwnershipError,
              ManagedPortReservationError,
              ManagedStackNotFoundError,
            ),
          ),
        ),
      abandonIdentityTransition: (input) =>
        transaction(
          database,
          () => abandonIdentityTransition(database, input),
          failsWith<ManagedIdentityRecoveryError>(ManagedIdentityTransitionOwnershipError),
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
      getStackProjection: (stackId) =>
        readTransaction(database, () => getStackProjection(database, stackId)),
      listStackProjections: (options) =>
        readTransaction(database, () =>
          options?.identity === undefined
            ? selectStackProjections(database, options)
            : selectStackProjectionsByIdentity(database, options.identity, options),
        ),
      findCheckoutContext: (checkoutId, kind) =>
        readTransaction(database, () => findCheckoutContext(database, checkoutId, kind)),
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
      pruneIdentityMetadata: (input) =>
        transaction(
          database,
          () => pruneIdentityMetadata(database, input),
          failsWith<ManagedIdentityRecoveryError>(
            ManagedCheckoutConflictError,
            ManagedCopiedBranchConflictError,
            ManagedIdentityTransitionOwnershipError,
            ManagedInaccessiblePathError,
          ),
        ),
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
): Layer.Layer<ManagedStackRepository> =>
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
