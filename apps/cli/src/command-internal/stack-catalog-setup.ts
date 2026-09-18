import { Context, Data, Effect, FileSystem, Layer, Path } from "effect";
import {
  type DatabaseInstance,
  type ServiceCreation,
  type ServiceInstance,
  type Stack,
} from "@supabase/stack/effect";
import { Output } from "../shared/output/output.service.ts";
import {
  actionability,
  type CliErrorActionabilityDeclaration,
  ErrorActionabilityId,
} from "../shared/telemetry/error-actionability.ts";
import { parseConnectionString } from "./db-config.parse.ts";
import type { DbConnectError } from "./db-connection.errors.ts";
import { DbConnection } from "./db-connection.service.ts";
import { dbConnectionLayer } from "./db-connection.layer.ts";
import {
  applyDatabaseOverlay,
  type ApplyDatabaseOverlayInput,
  type DbSetupError,
  type SetupDatabaseOptions,
} from "./db-bootstrap/db-setup.ts";
import type { MigrationVaultError, VaultSecret } from "./vault.ts";

const DATABASE_SERVICES = ["auth", "storage", "realtime"] as const;
type DatabaseService = (typeof DATABASE_SERVICES)[number];

interface ServiceCredentials {
  readonly databaseUrl: string;
  readonly authDatabaseUrl: string;
  readonly storageDatabaseUrl: string;
}

type TemporaryServiceInstance =
  | ServiceInstance<"auth">
  | ServiceInstance<"storage">
  | ServiceInstance<"realtime">;

export class StackCatalogSetupError extends Data.TaggedError("StackCatalogSetupError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.dbFinding;
  }
}

interface StackCatalogOverlay {
  readonly webhooks?: SetupDatabaseOptions["webhooks"];
  readonly webhooksEnabled: boolean;
  readonly apiAutoExposeNewTables: ApplyDatabaseOverlayInput["apiAutoExposeNewTables"];
  readonly vault: ReadonlyArray<VaultSecret>;
  readonly workdir: string;
  readonly announceRoles?: boolean;
}

export interface StackCatalogSetupInput {
  readonly target: {
    readonly stack: Stack;
    readonly database: DatabaseInstance;
    readonly databaseServices: ReadonlyArray<DatabaseService>;
    readonly jwtSecret: string;
  };
  readonly overlay: StackCatalogOverlay;
}

const catalogError = (cause: unknown): StackCatalogSetupError =>
  cause instanceof StackCatalogSetupError
    ? cause
    : new StackCatalogSetupError({
        message: cause instanceof Error ? cause.message : String(cause),
        cause,
      });

type StackCatalogSetupFailure =
  | StackCatalogSetupError
  | DbSetupError
  | MigrationVaultError
  | DbConnectError;

const temporaryServiceError = (
  operation: "start" | "destroy",
  instance: TemporaryServiceInstance,
  cause: unknown,
): StackCatalogSetupError =>
  new StackCatalogSetupError({
    message: `temporary ${instance.service} service ${instance.id} failed to ${operation}: ${cause instanceof Error ? cause.message : String(cause)}`,
    cause,
  });

const credential = (
  credentials: Readonly<Record<string, string>>,
  name: string,
): Effect.Effect<string, StackCatalogSetupError> => {
  const value = credentials[name];
  return value === undefined
    ? Effect.fail(new StackCatalogSetupError({ message: `database credential ${name} is missing` }))
    : Effect.succeed(value);
};

const serviceDefinition = (
  service: DatabaseService,
  credentials: ServiceCredentials,
  jwtSecret: string,
  storagePath: string,
): Extract<ServiceCreation, { readonly service: DatabaseService }> => {
  switch (service) {
    case "auth":
      return {
        service,
        config: {
          databaseUrl: credentials.authDatabaseUrl,
          jwtSecret,
        },
        endpoints: {},
      };
    case "storage":
      return {
        service,
        config: {
          databaseUrl: credentials.storageDatabaseUrl,
          filePath: storagePath,
          jwtSecret,
        },
        endpoints: {},
      };
    case "realtime":
      return {
        service,
        config: {
          databaseUrl: credentials.databaseUrl,
          jwtSecret,
        },
        endpoints: {},
      };
  }
};

const startTemporaryService = (
  instance: TemporaryServiceInstance,
): Effect.Effect<void, StackCatalogSetupError> =>
  instance.start.pipe(
    Effect.andThen(instance.ready),
    Effect.mapError((cause) => temporaryServiceError("start", instance, cause)),
  );

const destroyTemporaryService = (
  instance: TemporaryServiceInstance,
): Effect.Effect<void, StackCatalogSetupError> =>
  instance.destroy.pipe(
    Effect.mapError((cause) => temporaryServiceError("destroy", instance, cause)),
  );

const applyCatalog = Effect.fn("StackCatalogSetup.apply")(function* (
  input: StackCatalogSetupInput,
) {
  const dbConn = yield* DbConnection;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const runtimeCredentials = yield* input.target.database
    .credentials({ from: "runtime" })
    .pipe(Effect.mapError(catalogError));
  const hostCredentials = yield* input.target.database
    .credentials({ from: "host" })
    .pipe(Effect.mapError(catalogError));
  yield* Effect.scoped(
    Effect.gen(function* () {
      const runtimeDatabaseUrl = yield* credential(runtimeCredentials, "databaseUrl");
      const authDatabaseUrl = yield* credential(runtimeCredentials, "authDatabaseUrl");
      const storageDatabaseUrl = yield* credential(runtimeCredentials, "storageDatabaseUrl");
      const hostDatabaseUrl = yield* credential(hostCredentials, "databaseUrl");
      const serviceCredentials: ServiceCredentials = {
        databaseUrl: runtimeDatabaseUrl,
        authDatabaseUrl,
        storageDatabaseUrl,
      };
      const storagePath = yield* fs
        .makeTempDirectoryScoped({ prefix: "supabase-stack-catalog-storage-" })
        .pipe(Effect.mapError(catalogError));

      yield* Effect.forEach(
        input.target.databaseServices,
        (service) =>
          Effect.acquireUseRelease(
            input.target.stack.services
              .create(
                serviceDefinition(service, serviceCredentials, input.target.jwtSecret, storagePath),
              )
              .pipe(Effect.mapError(catalogError)),
            startTemporaryService,
            destroyTemporaryService,
          ),
        { discard: true },
      );

      const connection = parseConnectionString(hostDatabaseUrl);
      if (connection === undefined)
        return yield* new StackCatalogSetupError({
          message: "failed to parse database URL for catalog overlay",
        });
      const session = yield* dbConn.connect(connection, {
        isLocal: true,
        dnsResolver: "native",
      });
      yield* applyDatabaseOverlay(session, fs, path, input.overlay.workdir, {
        webhooksEnabled: input.overlay.webhooksEnabled,
        apiAutoExposeNewTables: input.overlay.apiAutoExposeNewTables,
        vault: input.overlay.vault,
        webhooks: input.overlay.webhooks,
        announceRoles: input.overlay.announceRoles,
      });
    }),
  );
});

export class StackCatalogSetup extends Context.Service<
  StackCatalogSetup,
  {
    readonly apply: (
      input: StackCatalogSetupInput,
    ) => Effect.Effect<void, StackCatalogSetupFailure, Output | FileSystem.FileSystem | Path.Path>;
  }
>()("supabase/cli/StackCatalogSetup") {}

export const stackCatalogSetupLayer = Layer.effect(
  StackCatalogSetup,
  Effect.gen(function* () {
    const dbConn = yield* DbConnection;
    return StackCatalogSetup.of({
      apply: (input) => applyCatalog(input).pipe(Effect.provideService(DbConnection, dbConn)),
    });
  }),
).pipe(Layer.provide(dbConnectionLayer));
