import { Effect, FileSystem, Layer, Option, Path } from "effect";
import { DatabaseTargetResolver } from "../../shared/database/database-target.service.ts";
import { envDatabaseUrl, type DatabaseTarget } from "../../shared/database/database-target.ts";
import { LinkedRemoteConnector } from "../../shared/database/linked-remote-connector.service.ts";
import { LocalDatabaseFallback } from "../../shared/database/local-database-fallback.service.ts";
import {
  SchemaLinkedConnectionError,
  SchemaLocalStackNotRunningError,
} from "../../shared/schema/schema-errors.ts";
import { LegacyCliConfig } from "../config/legacy-cli-config.service.ts";
import { PROJECT_REF_PATTERN } from "../config/legacy-project-ref.service.ts";
import { legacyReadProjectRefFile } from "../shared/legacy-temp-paths.ts";

export const legacySchemaDatabaseTargetLayer = Layer.effect(
  DatabaseTargetResolver,
  Effect.gen(function* () {
    const localDb = yield* LocalDatabaseFallback;
    const linkedRemote = yield* LinkedRemoteConnector;
    const config = yield* LegacyCliConfig;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;

    const resolveLocal = Effect.gen(function* () {
      const owned = yield* localDb.resolve;
      if (Option.isNone(owned)) {
        return yield* new SchemaLocalStackNotRunningError({
          detail: "No local Supabase database container is running for this project.",
          suggestion: "Run `supabase start` or `supabase db start`, then retry.",
        });
      }
      return owned.value;
    });

    const resolveLinkedRef = Effect.gen(function* () {
      if (Option.isSome(config.projectId) && PROJECT_REF_PATTERN.test(config.projectId.value)) {
        return config.projectId.value;
      }
      const fileRef = yield* legacyReadProjectRefFile(fs, path, config.workdir).pipe(
        Effect.mapError(
          (error) =>
            new SchemaLinkedConnectionError({
              detail: error.message,
              suggestion: "Fix or remove supabase/.temp/project-ref, then retry.",
            }),
        ),
      );
      if (Option.isNone(fileRef)) {
        return yield* new SchemaLinkedConnectionError({
          detail: "This project is not linked to a Supabase project.",
          suggestion: "Run `supabase link`, or pass --from / --against with a connection string.",
        });
      }
      if (!PROJECT_REF_PATTERN.test(fileRef.value)) {
        return yield* new SchemaLinkedConnectionError({
          detail: "supabase/.temp/project-ref is not a valid project ref.",
          suggestion: "Run `supabase link` again, or remove the invalid project-ref file.",
        });
      }
      return fileRef.value;
    });

    const resolveLinked = Effect.gen(function* () {
      const url = envDatabaseUrl();
      if (url !== undefined) {
        return {
          kind: "url",
          identity: "connection-string",
          connectionString: url,
          disposable: false,
          durable: true,
          connectionVerified: false,
          connectionSource: "env",
        } satisfies DatabaseTarget;
      }
      const ref = yield* resolveLinkedRef;
      const connectionString = yield* linkedRemote.connect(ref);
      return {
        kind: "linked",
        identity: ref,
        connectionString,
        disposable: false,
        durable: true,
        connectionVerified: true,
        projectRef: ref,
      } satisfies DatabaseTarget;
    });

    return DatabaseTargetResolver.of({
      resolve: (selector) => {
        if (selector.kind === "local") return resolveLocal;
        if (selector.kind === "linked") return resolveLinked;
        return Effect.succeed({
          kind: "url",
          identity: "connection-string",
          connectionString: selector.url,
          disposable: false,
          durable: true,
          connectionVerified: false,
          connectionSource: "flag",
        } satisfies DatabaseTarget);
      },
    });
  }),
);
