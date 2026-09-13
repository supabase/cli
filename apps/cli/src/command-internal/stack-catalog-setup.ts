import { Context, Crypto, Data, Effect, FileSystem, Layer, Path, Redacted } from "effect";
import { ChildProcessSpawner } from "effect/unstable/process";
import {
  schemaInit,
  type EffectStack,
  type SchemaInitCapabilityName,
  type SchemaInitTarget,
  type StackConfig,
  type StackRuntime,
} from "@supabase/stack/effect";
import { Output } from "../shared/output/output.service.ts";
import { parseConnectionString } from "./db-config.parse.ts";
import { DbConnection } from "./db-connection.service.ts";
import { dbConnectionLayer } from "./db-connection.layer.ts";
import {
  applyDatabaseOverlay,
  type ApplyDatabaseOverlayInput,
  type SetupDatabaseOptions,
} from "./db-bootstrap/db-setup.ts";
import type { VaultSecret } from "./vault.ts";

const PLATFORM_TRIO = ["auth", "storage", "realtime"] as const satisfies ReadonlyArray<
  SchemaInitCapabilityName
>;
const OPTIONAL_CAPS = ["analytics", "pooler"] as const satisfies ReadonlyArray<SchemaInitCapabilityName>;

export class StackCatalogSetupError extends Data.TaggedError("StackCatalogSetupError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

export interface StackCatalogOverlay {
  readonly webhooks?: SetupDatabaseOptions["webhooks"];
  readonly webhooksEnabled: boolean;
  readonly apiAutoExposeNewTables: ApplyDatabaseOverlayInput["apiAutoExposeNewTables"];
  readonly vault: ReadonlyArray<VaultSecret>;
  readonly workdir: string;
  readonly announceRoles?: boolean;
}

export interface LiveStackCatalogInput {
  readonly kind: "live";
  readonly stack: EffectStack;
  readonly projectRoot: string;
  readonly config: StackConfig;
}

export interface EphemeralStackCatalogInput {
  readonly kind: "ephemeral";
  readonly projectRoot: string;
  readonly runtime: StackRuntime;
  readonly config: StackConfig;
  readonly databaseUrl: string;
  readonly databasePassword: Redacted.Redacted<string>;
  readonly jwtSecret?: Redacted.Redacted<string>;
}

export interface StackCatalogSetupInput {
  readonly target: LiveStackCatalogInput | EphemeralStackCatalogInput;
  readonly overlay: StackCatalogOverlay;
}

const capabilityEnabled = (config: StackConfig, name: SchemaInitCapabilityName): boolean => {
  const cap = config.capabilities?.[name];
  return cap === undefined || cap.enabled !== false;
};

const jwtSecretFromConfig = (config: StackConfig): Redacted.Redacted<string> | undefined => {
  const signing = config.security?.jwt?.signing;
  return signing?.kind === "symmetric" ? signing.secret : undefined;
};

const catalogError = (error: { readonly message: string }): StackCatalogSetupError =>
  new StackCatalogSetupError({ message: error.message, cause: error });

const runSchemaInit = (
  names: ReadonlyArray<SchemaInitCapabilityName>,
  target: SchemaInitTarget,
) =>
  names.length === 0 ? Effect.void : schemaInit(names, target).pipe(Effect.mapError(catalogError));

const targetConnection = (target: LiveStackCatalogInput | EphemeralStackCatalogInput) =>
  target.kind === "ephemeral"
    ? Effect.succeed({
        databaseUrl: target.databaseUrl,
        databasePassword: target.databasePassword,
        jwtSecret: target.jwtSecret,
        runtime: target.runtime,
      })
    : Effect.gen(function* () {
        const credentials = yield* target.stack.credentials.pipe(Effect.mapError(catalogError));
        const status = yield* target.stack.status.pipe(Effect.mapError(catalogError));
        return {
          databaseUrl: Redacted.value(credentials.database.url),
          databasePassword: credentials.database.password,
          jwtSecret: jwtSecretFromConfig(target.config),
          runtime: status.runtime,
        };
      });

const applyCatalog = (input: StackCatalogSetupInput) =>
  Effect.gen(function* () {
    const output = yield* Output;
    const dbConn = yield* DbConnection;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const connection = yield* targetConnection(input.target);
    const schemaTarget: SchemaInitTarget =
      input.target.kind === "live"
        ? {
            kind: "live",
            stackId: input.target.stack.id,
            projectRoot: input.target.projectRoot,
            runtime: connection.runtime,
            config: input.target.config,
            databaseUrl: connection.databaseUrl,
            secrets: {
              databasePassword: connection.databasePassword,
              ...(connection.jwtSecret === undefined ? {} : { jwtSecret: connection.jwtSecret }),
            },
          }
        : {
            kind: "ephemeral",
            projectRoot: input.target.projectRoot,
            runtime: connection.runtime,
            config: input.target.config,
            databaseUrl: connection.databaseUrl,
            secrets: {
              databasePassword: connection.databasePassword,
              ...(connection.jwtSecret === undefined ? {} : { jwtSecret: connection.jwtSecret }),
            },
          };
    const config = input.target.config;
    const failClosed = PLATFORM_TRIO.filter((name) => capabilityEnabled(config, name));
    yield* runSchemaInit(failClosed, schemaTarget);
    if (input.target.kind === "live") {
      const optional = OPTIONAL_CAPS.filter((name) => capabilityEnabled(config, name));
      yield* Effect.forEach(
        optional,
        (name) =>
          schemaInit([name], schemaTarget).pipe(
            Effect.catchTag("RequiresActivatedProcessError", (error) =>
              output.raw(
                `WARNING: skipped ${error.capability} schema init: ${error.message}\n`,
                "stderr",
              ),
            ),
            Effect.mapError(catalogError),
          ),
        { discard: true },
      );
    }
    const conn = parseConnectionString(connection.databaseUrl);
    if (conn === undefined) {
      yield* new StackCatalogSetupError({
        message: "failed to parse database URL for catalog overlay",
      });
      return;
    }
    yield* Effect.scoped(
      Effect.gen(function* () {
        const session = yield* dbConn
          .connect(conn, { isLocal: true, dnsResolver: "native" })
          .pipe(Effect.mapError(catalogError));
        yield* applyDatabaseOverlay(session, fs, path, input.overlay.workdir, {
          webhooksEnabled: input.overlay.webhooksEnabled,
          apiAutoExposeNewTables: input.overlay.apiAutoExposeNewTables,
          vault: input.overlay.vault,
          webhooks: input.overlay.webhooks,
          announceRoles: input.overlay.announceRoles,
        }).pipe(Effect.mapError(catalogError));
      }),
    );
  });

export class StackCatalogSetup extends Context.Service<
  StackCatalogSetup,
  {
    readonly apply: (
      input: StackCatalogSetupInput,
    ) => Effect.Effect<void, StackCatalogSetupError, Output>;
  }
>()("supabase/cli/StackCatalogSetup") {}

type CatalogApplyServices =
  | DbConnection
  | FileSystem.FileSystem
  | Path.Path
  | Crypto.Crypto
  | ChildProcessSpawner.ChildProcessSpawner;

export const stackCatalogSetupLayer = Layer.effect(
  StackCatalogSetup,
  Effect.gen(function* () {
    const context = yield* Effect.context<CatalogApplyServices>();
    return {
      apply: (input: StackCatalogSetupInput) =>
        applyCatalog(input).pipe(Effect.provideContext(context), Effect.asVoid),
    };
  }),
).pipe(Layer.provide(dbConnectionLayer));

export const noopStackCatalogSetupLayer = Layer.succeed(StackCatalogSetup, {
  apply: () => Effect.void,
});
