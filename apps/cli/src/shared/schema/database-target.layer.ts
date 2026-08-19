import { Effect, FileSystem, Layer, Option, Path } from "effect";
import {
  connectLayer,
  DEFAULT_MANAGED_STACK_NAME,
  Stack,
  unixHttpClientLayer,
} from "@supabase/stack/effect";
import { CliConfig } from "../../next/config/cli-config.service.ts";
import { ProjectHome } from "../../next/config/project-home.service.ts";
import { ProjectLinkState } from "../../next/config/project-link-state.service.ts";
import { LocalDatabaseFallback } from "../database/local-database-fallback.service.ts";
import { DatabaseTargetResolver } from "../database/database-target.service.ts";
import type { DatabaseTarget } from "../database/database-target.ts";
import { RuntimeInfo } from "../runtime/runtime-info.service.ts";
import { SchemaLinkedConnectionError, SchemaLocalStackNotRunningError } from "./schema-errors.ts";

function envConnectionString(): string | undefined {
  return process.env["SUPABASE_DB_URL"] ?? process.env["DATABASE_URL"];
}

export const databaseTargetLayer = Layer.effect(
  DatabaseTargetResolver,
  Effect.gen(function* () {
    const projectHome = yield* ProjectHome;
    const runtimeInfo = yield* RuntimeInfo;
    const cliConfig = yield* CliConfig;
    const linkState = yield* ProjectLinkState;
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;

    const fallback = yield* LocalDatabaseFallback;

    const resolveLocal = Effect.gen(function* () {
      const layer = yield* connectLayer({
        cwd: runtimeInfo.cwd,
        cacheRoot: cliConfig.supabaseHome,
        projectDir: projectHome.projectRoot,
        projectStateRoot: projectHome.projectHomeDir,
        name: DEFAULT_MANAGED_STACK_NAME,
      }).pipe(
        Effect.map(Option.some),
        Effect.catchTag("NoRunningStackError", () => Effect.succeed(Option.none())),
        Effect.catchTag("InvalidStackStateError", () => Effect.succeed(Option.none())),
      );
      if (layer._tag === "None") {
        const owned = yield* fallback.resolve;
        if (Option.isSome(owned)) {
          return owned.value;
        }
        return yield* new SchemaLocalStackNotRunningError({
          detail: "No local Supabase stack is running for this project.",
          suggestion: "Run `supabase start`, then retry.",
        });
      }
      const stack = yield* Effect.provide(Stack, layer.value);
      const info = yield* stack.getInfo();
      return {
        kind: "local",
        identity: `local:${DEFAULT_MANAGED_STACK_NAME}`,
        connectionString: info.dbUrl,
        disposable: true,
        durable: false,
        connectionVerified: true,
      } satisfies DatabaseTarget;
    }).pipe(
      Effect.provide(unixHttpClientLayer),
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(Path.Path, path),
    );

    const resolveLinked = Effect.gen(function* () {
      const linked = yield* linkState.load.pipe(
        Effect.mapError(
          (error) =>
            new SchemaLinkedConnectionError({
              detail: error.detail,
              suggestion: error.suggestion,
            }),
        ),
      );
      if (linked._tag === "None") {
        return yield* new SchemaLinkedConnectionError({
          detail: "This project is not linked to a Supabase project.",
          suggestion: "Run `supabase link`, or pass --from / --against with a connection string.",
        });
      }
      const url = envConnectionString();
      if (url === undefined) {
        return yield* new SchemaLinkedConnectionError({
          detail: `Linked project ${linked.value.project.ref} has no connection string in this environment.`,
          suggestion:
            "Pass --from / --against / --db-url with a connection string, or set DATABASE_URL / SUPABASE_DB_URL.",
        });
      }
      return {
        kind: "linked",
        identity: linked.value.project.ref,
        connectionString: url,
        disposable: false,
        durable: true,
        connectionVerified: false,
        projectRef: linked.value.project.ref,
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
        } satisfies DatabaseTarget);
      },
    });
  }),
);
