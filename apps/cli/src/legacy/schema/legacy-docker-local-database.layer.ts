import { isDockerDaemonDownMessage } from "@supabase/stack/effect";
import { Effect, FileSystem, Layer, Option, Path } from "effect";
import { ChildProcessSpawner } from "effect/unstable/process";
import type { DatabaseTarget } from "../../shared/database/database-target.ts";
import { LocalDatabaseFallback } from "../../shared/database/local-database-fallback.service.ts";
import {
  localPostgresConnectionString,
  publishedPostgresHostPort,
} from "../../shared/database/local-postgres-url.ts";
import { SchemaLocalStackNotRunningError } from "../../shared/schema/schema-errors.ts";
import { LegacyCliConfig } from "../config/legacy-cli-config.service.ts";
import {
  legacyCollectText,
  legacyDescribeContainerCliFailure,
  legacyIsContainerNotFoundMessage,
  spawnContainerCli,
} from "../shared/legacy-container-cli.ts";
import { legacyReadDbToml } from "../shared/legacy-db-config.toml-read.ts";
import { legacyResolveLocalProjectId, localDbContainerId } from "../shared/legacy-docker-ids.ts";
import { legacyGetHostname } from "../shared/legacy-hostname.ts";

type Spawner = ChildProcessSpawner.ChildProcessSpawner["Service"];

const inspectPublishedPostgresPort = (spawner: Spawner, containerId: string) =>
  Effect.scoped(
    Effect.gen(function* () {
      const spawned = yield* spawnContainerCli(
        spawner,
        ["container", "inspect", containerId, "--format", "{{json .NetworkSettings.Ports}}"],
        { stdin: "ignore", stdout: "pipe", stderr: "pipe" },
      ).pipe(
        Effect.map(Option.some),
        Effect.catchTag("LegacyContainerRuntimeNotFoundError", () => Effect.succeed(Option.none())),
        Effect.mapError((cause) => {
          const description = legacyDescribeContainerCliFailure(cause);
          return new SchemaLocalStackNotRunningError({
            detail: `failed to inspect local database container: ${description}`,
            suggestion: isDockerDaemonDownMessage(description)
              ? "Start Docker Desktop or Podman, then run `supabase start`."
              : "Run `supabase start`, then retry.",
          });
        }),
      );
      if (Option.isNone(spawned)) {
        return Option.none<number>();
      }
      const child = spawned.value;
      const [exitCode, stdout, stderr] = yield* Effect.all(
        [
          child.exitCode.pipe(Effect.map(Number)),
          legacyCollectText(child.stdout),
          legacyCollectText(child.stderr),
        ],
        { concurrency: "unbounded" },
      ).pipe(
        Effect.mapError(
          () =>
            new SchemaLocalStackNotRunningError({
              detail: "failed to inspect local database container",
              suggestion: "Run `supabase start`, then retry.",
            }),
        ),
      );
      if (exitCode !== 0) {
        const message = stderr.trim();
        if (legacyIsContainerNotFoundMessage(message)) {
          return Option.none<number>();
        }
        return yield* new SchemaLocalStackNotRunningError({
          detail:
            message.length > 0
              ? `failed to inspect local database container: ${message}`
              : "failed to inspect local database container",
          suggestion: isDockerDaemonDownMessage(message)
            ? "Start Docker Desktop or Podman, then run `supabase start`."
            : "Run `supabase start`, then retry.",
        });
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(stdout.trim() || "null");
      } catch {
        return yield* new SchemaLocalStackNotRunningError({
          detail: "failed to parse local database container port map",
          suggestion: "Run `supabase start`, then retry.",
        });
      }
      const port = publishedPostgresHostPort(parsed);
      if (port === undefined) {
        return yield* new SchemaLocalStackNotRunningError({
          detail: `local database container ${containerId} does not publish 5432/tcp`,
          suggestion: "Run `supabase start`, then retry.",
        });
      }
      return Option.some(port);
    }),
  );

export const legacyDockerLocalDatabaseFallbackLayer = Layer.effect(
  LocalDatabaseFallback,
  Effect.gen(function* () {
    const config = yield* LegacyCliConfig;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

    return LocalDatabaseFallback.of({
      resolve: Effect.gen(function* () {
        const toml = yield* legacyReadDbToml(fs, path, config.workdir, undefined, {
          validate: false,
          warnOnUnresolvedEnv: false,
        }).pipe(Effect.orElseSucceed(() => undefined));
        const projectId = legacyResolveLocalProjectId(
          Option.getOrUndefined(config.projectId),
          toml === undefined ? undefined : Option.getOrUndefined(toml.projectId),
          config.workdir,
        );
        const published = yield* inspectPublishedPostgresPort(
          spawner,
          localDbContainerId(projectId),
        );
        if (Option.isNone(published)) {
          return Option.none();
        }
        return Option.some({
          kind: "local",
          identity: "local:default",
          connectionString: localPostgresConnectionString(
            published.value,
            toml?.password ?? "postgres",
            legacyGetHostname(),
          ),
          disposable: true,
          durable: false,
          connectionVerified: true,
        } satisfies DatabaseTarget);
      }),
    });
  }),
);
