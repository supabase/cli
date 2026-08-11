import { Schema } from "effect";
import {
  DuplicateManagedIdentityError,
  MANAGED_REGISTRY_SCHEMA_VERSION,
  ManagedOperationOwnershipError,
  ManagedPortReservationError,
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
  ClaimManagedOperationInput,
  ClaimManagedOperationResult,
  ManagedStackRepository,
  PrepareOrdinaryStackInput,
  PrepareOrdinaryStackResult,
  UpdateManagedStackInput,
} from "./repository.ts";
import { reconcileManagedPortAssignments, validateManagedPortAssignments } from "./repository.ts";

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

const sqliteErrorCode = (error: unknown): string | undefined => {
  if (typeof error !== "object" || error === null) {
    return undefined;
  }
  const code = Reflect.get(error, "code");
  return typeof code === "string" ? code : undefined;
};

const isSqliteBusy = (error: unknown): boolean => {
  const code = sqliteErrorCode(error);
  if (code === "SQLITE_BUSY" || code === "SQLITE_LOCKED") {
    return true;
  }
  return error instanceof Error && /database is (?:busy|locked)/i.test(error.message);
};

const synchronousWait = (milliseconds: number): void => {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
};

const enableWriteAheadLogging = (database: ManagedSqliteDatabase): void => {
  for (let attempt = 0; ; attempt += 1) {
    try {
      database.exec("PRAGMA journal_mode = WAL");
      return;
    } catch (error: unknown) {
      if (!isSqliteBusy(error) || attempt >= 49) {
        throw error;
      }
      synchronousWait(Math.min(10 + attempt * 5, 100));
    }
  }
};

const rollbackPreservingCause = (database: ManagedSqliteDatabase): void => {
  try {
    database.exec("ROLLBACK");
  } catch {
    // The original transaction error is more useful than a secondary rollback failure.
  }
};

const initializeSchema = (database: ManagedSqliteDatabase): void => {
  database.exec("PRAGMA busy_timeout = 5000");
  database.exec("PRAGMA foreign_keys = ON");
  enableWriteAheadLogging(database);
  database.exec("BEGIN IMMEDIATE");
  try {
    const versionRow = database.prepare("PRAGMA user_version").get();
    const version = getNumber(versionRow, "user_version");
    if (version > MANAGED_REGISTRY_SCHEMA_VERSION) {
      throw new UnsupportedManagedRegistryVersionError(version, MANAGED_REGISTRY_SCHEMA_VERSION);
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
        kind TEXT NOT NULL CHECK (kind IN ('workspace', 'branch', 'detached')),
        locator TEXT,
        status TEXT NOT NULL CHECK (status IN ('active', 'orphaned')),
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

const transaction = <A>(database: ManagedSqliteDatabase, run: () => A): A => {
  database.exec("BEGIN IMMEDIATE");
  try {
    const result = run();
    database.exec("COMMIT");
    return result;
  } catch (error: unknown) {
    rollbackPreservingCause(database);
    throw error;
  }
};

const readTransaction = <A>(database: ManagedSqliteDatabase, run: () => A): A => {
  database.exec("BEGIN");
  try {
    const result = run();
    database.exec("COMMIT");
    return result;
  } catch (error: unknown) {
    rollbackPreservingCause(database);
    throw error;
  }
};

const queryPorts = (
  database: ManagedSqliteDatabase,
  stackId: string,
): ReadonlyArray<ManagedPortAssignment> =>
  database
    .prepare("SELECT key, port, intent FROM ports WHERE stack_id = ? ORDER BY key")
    .all([stackId])
    .map((row) => ({
      key: getString(row, "key"),
      port: getNumber(row, "port"),
      intent: managedPortIntent(getString(row, "intent")),
    }));

const decodeStack = (database: ManagedSqliteDatabase, row: unknown): ManagedStackRecord => {
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
    ports: queryPorts(database, id),
    serviceVersions: decodeStringRecord(parseJson(getString(row, "service_versions_json"))),
    runtimeMetadata: decodeRuntimeMetadata(parseJson(getString(row, "runtime_metadata_json"))),
    configFingerprint: getOptionalString(row, "config_fingerprint"),
    credentialsReference: getOptionalString(row, "credentials_reference"),
    createdAt: getString(row, "created_at"),
    updatedAt: getString(row, "updated_at"),
    tombstonedAt: getOptionalString(row, "tombstoned_at"),
  };
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
    throw new ManagedStackNotFoundError(stackId);
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
    throw new ManagedOperationOwnershipError(stackId);
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
  if (lifecycle === "running" || lifecycle === "starting" || lifecycle === "stopping") {
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
        throw new ManagedPortReservationError(assignment.port, getString(owner, "stack_id"));
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
): ClaimManagedOperationResult =>
  transaction(database, () => {
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
      throw new ManagedOperationOwnershipError(input.stackId);
    }
    return { acquired: true, operation };
  });

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

export const createSqliteManagedStackRepository = (
  database: ManagedSqliteDatabase,
): ManagedStackRepository => {
  initializeSchema(database);

  return {
    kind: "sqlite",
    prepareOrdinaryStack(input): PrepareOrdinaryStackResult {
      return transaction(database, () => {
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
          throw new DuplicateManagedIdentityError(
            input.identity.checkoutId,
            getString(checkoutRow, "project_id"),
            input.identity.projectId,
          );
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
          throw new DuplicateManagedIdentityError(
            input.identity.contextId,
            getString(contextRow, "checkout_id"),
            input.identity.checkoutId,
          );
        }
        database
          .prepare(
            `INSERT OR IGNORE INTO contexts
              (id, checkout_id, kind, locator, status, created_at)
             VALUES (?, ?, 'workspace', NULL, 'active', ?)`,
          )
          .run([input.identity.contextId, input.identity.checkoutId, input.now]);

        const checkoutLocation = database
          .prepare("SELECT * FROM checkout_locations WHERE checkout_id = ?")
          .get([input.identity.checkoutId]);
        if (
          checkoutLocation !== undefined &&
          getString(checkoutLocation, "canonical_path") !== input.canonicalPath
        ) {
          throw new DuplicateManagedIdentityError(
            input.identity.checkoutId,
            getString(checkoutLocation, "canonical_path"),
            input.canonicalPath,
          );
        }
        const pathLocation = database
          .prepare("SELECT * FROM checkout_locations WHERE canonical_path = ?")
          .get([input.canonicalPath]);
        if (
          pathLocation !== undefined &&
          getString(pathLocation, "checkout_id") !== input.identity.checkoutId
        ) {
          throw new DuplicateManagedIdentityError(
            input.canonicalPath,
            getString(pathLocation, "checkout_id"),
            input.identity.checkoutId,
          );
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
          throw new ManagedOperationOwnershipError(input.stackId);
        }
        return { outcome: "create", stack, operation };
      });
    },
    publishPendingStack(stackId, operationToken, now) {
      return transaction(database, () => {
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
      });
    },
    abortPendingStack(stackId, operationToken) {
      transaction(database, () => {
        requireOwnedOperation(database, stackId, operationToken);
        const stack = requireStack(database, stackId);
        if (stack.status !== "pending") {
          throw new ManagedOperationOwnershipError(stackId);
        }
        database.prepare("DELETE FROM stacks WHERE id = ?").run([stackId]);
      });
    },
    getStack(stackId) {
      return readTransaction(database, () => getStack(database, stackId));
    },
    getStackByIdentity(checkoutId, contextId, stackName) {
      return readTransaction(database, () => {
        const row = database
          .prepare(
            `SELECT * FROM stacks
             WHERE checkout_id = ? AND context_id = ? AND name = ? AND status != 'tombstoned'`,
          )
          .get([checkoutId, contextId, stackName]);
        return row === undefined ? undefined : decodeStack(database, row);
      });
    },
    listStacks(options) {
      return readTransaction(database, () => {
        const rows =
          options?.includeTombstoned === true
            ? database.prepare("SELECT * FROM stacks ORDER BY created_at, id").all()
            : database
                .prepare(
                  "SELECT * FROM stacks WHERE status != 'tombstoned' ORDER BY created_at, id",
                )
                .all();
        return rows.map((row) => decodeStack(database, row));
      });
    },
    claimOperation(input) {
      return claimOperation(database, input);
    },
    finishOperation(stackId, operationToken, outcome, now, error) {
      transaction(database, () => {
        requireOwnedOperation(database, stackId, operationToken);
        database
          .prepare(
            `UPDATE operations
             SET status = ?, finished_at = ?, error = ?
             WHERE token = ? AND stack_id = ?`,
          )
          .run([outcome, now, error ?? null, operationToken, stackId]);
      });
    },
    updateStack(input: UpdateManagedStackInput) {
      return transaction(database, () => {
        requireOwnedOperation(database, input.stackId, input.operationToken);
        const current = requireStack(database, input.stackId);
        const runtimeRequest = input.runtimeRequest ?? current.runtimeRequest;
        const runtime = input.runtime ?? current.runtime;
        const lifecycle = input.lifecycle ?? current.lifecycle;
        const serviceVersions = input.serviceVersions ?? current.serviceVersions;
        const runtimeMetadata = input.runtimeMetadata ?? current.runtimeMetadata;
        const configFingerprint = input.configFingerprint ?? current.configFingerprint;
        const credentialsReference = input.credentialsReference ?? current.credentialsReference;
        const ports = reconcileManagedPortAssignments(current, input.ports);
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
      });
    },
    listActiveOperations(startedBefore) {
      const rows =
        startedBefore === undefined
          ? database
              .prepare("SELECT * FROM operations WHERE status = 'active' ORDER BY started_at")
              .all()
          : database
              .prepare(
                `SELECT * FROM operations
                 WHERE status = 'active' AND started_at < ? ORDER BY started_at`,
              )
              .all([startedBefore]);
      return rows.map(decodeOperation);
    },
    reconcileOperation(stackId, operationToken, lifecycle, now) {
      return transaction(database, () => {
        requireOwnedOperation(database, stackId, operationToken);
        const current = requireStack(database, stackId);
        if (current.status === "pending" && lifecycle === "stopped") {
          database.prepare("DELETE FROM stacks WHERE id = ?").run([stackId]);
          return undefined;
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
          .run([
            now,
            `Recovered after runtime reconciliation (${lifecycle})`,
            operationToken,
            stackId,
          ]);
        return requireStack(database, stackId);
      });
    },
    tombstoneStack(stackId, operationToken, now) {
      return transaction(database, () => {
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
      });
    },
    listCheckoutLocations() {
      return database
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
    },
    pruneCheckoutLocations(locationIds) {
      return transaction(database, () => {
        let removed = 0;
        const statement = database.prepare("DELETE FROM checkout_locations WHERE id = ?");
        for (const id of new Set(locationIds)) {
          const existing = database
            .prepare("SELECT id FROM checkout_locations WHERE id = ?")
            .get([id]);
          if (existing !== undefined) {
            statement.run([id]);
            removed += 1;
          }
        }
        return removed;
      });
    },
    close() {
      database.close();
    },
  };
};
