import { Context, Crypto, Data, Effect, FileSystem, Layer, Path, Redacted } from "effect";
import { ChildProcessSpawner } from "effect/unstable/process";
import {
  type EffectServiceInstance,
  type EffectStack,
  type StackConfig,
} from "@supabase/stack/effect";
import { Output } from "../shared/output/output.service.ts";
import {
  actionability,
  type CliErrorActionabilityDeclaration,
  ErrorActionabilityId,
} from "../shared/telemetry/error-actionability.ts";
import { parseConnectionString } from "./db-config.parse.ts";
import { DbConnection } from "./db-connection.service.ts";
import { dbConnectionLayer } from "./db-connection.layer.ts";
import {
  applyDatabaseOverlay,
  type ApplyDatabaseOverlayInput,
  type SetupDatabaseOptions,
} from "./db-bootstrap/db-setup.ts";
import type { VaultSecret } from "./vault.ts";

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

interface LiveStackCatalogInput {
  readonly kind: "live";
  readonly stack: EffectStack;
  readonly projectRoot: string;
  readonly config?: StackConfig;
}

interface ServiceStackCatalogInput {
  readonly kind: "service";
  readonly stack: EffectStack;
  readonly service: EffectServiceInstance<"database">;
  readonly projectRoot: string;
  readonly config?: StackConfig;
}

export interface StackCatalogSetupInput {
  readonly target: LiveStackCatalogInput | ServiceStackCatalogInput;
  readonly overlay: StackCatalogOverlay;
  readonly config?: StackConfig;
  readonly optionalConfig?: StackConfig;
}

const catalogError = (error: { readonly message: string }): StackCatalogSetupError =>
  new StackCatalogSetupError({ message: error.message, cause: error });

const credentialValue = (value: string | Redacted.Redacted<string>): string =>
  typeof value === "string" ? value : Redacted.value(value);

const targetConnection = (target: LiveStackCatalogInput | ServiceStackCatalogInput) =>
  Effect.gen(function* () {
    if (target.kind === "service") {
      const credentials = yield* target.service.credentials;
      if (credentials === undefined)
        return yield* new StackCatalogSetupError({
          message: "stack database credentials are unavailable",
        });
      return { databaseUrl: credentialValue(credentials.url) };
    }
    const credentials = yield* target.stack.credentials;
    if (credentials.database === undefined)
      return yield* new StackCatalogSetupError({
        message: "stack database credentials are unavailable",
      });
    return { databaseUrl: Redacted.value(credentials.database.url) };
  }).pipe(Effect.mapError(catalogError));

const applyCatalog = (input: StackCatalogSetupInput) =>
  Effect.gen(function* () {
    const dbConn = yield* DbConnection;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const connection = yield* targetConnection(input.target);
    const conn = parseConnectionString(connection.databaseUrl);
    if (conn === undefined) {
      return yield* new StackCatalogSetupError({
        message: "failed to parse database URL for catalog overlay",
      });
    }
    yield* Effect.scoped(
      Effect.gen(function* () {
        const session = yield* dbConn.connect(conn, { isLocal: true, dnsResolver: "native" });
        yield* applyDatabaseOverlay(session, fs, path, input.overlay.workdir, {
          webhooksEnabled: input.overlay.webhooksEnabled,
          apiAutoExposeNewTables: input.overlay.apiAutoExposeNewTables,
          vault: input.overlay.vault,
          webhooks: input.overlay.webhooks,
          announceRoles: input.overlay.announceRoles,
        });
      }).pipe(Effect.mapError(catalogError)),
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

export const recordingStackCatalogSetup = <A>(record: (input: StackCatalogSetupInput) => A) => {
  const applied: Array<A> = [];
  return {
    applied,
    layer: Layer.succeed(StackCatalogSetup, {
      apply: (input) =>
        Effect.sync(() => {
          applied.push(record(input));
        }),
    }),
  };
};
