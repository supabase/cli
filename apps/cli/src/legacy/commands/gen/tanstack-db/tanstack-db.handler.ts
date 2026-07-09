import { loadProjectConfig } from "@supabase/config";
import { defaultPublishableKey } from "@supabase/stack/effect";
import { Effect, Option } from "effect";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import { ensureMutuallyExclusive } from "../../../../shared/cli/cobra-flag-groups.ts";
import { Output } from "../../../../shared/output/output.service.ts";
import { LegacyPlatformApiFactory } from "../../../auth/legacy-platform-api-factory.service.ts";
import { LegacyCliConfig } from "../../../config/legacy-cli-config.service.ts";
import { LegacyProjectNotLinkedError } from "../../../config/legacy-project-ref.errors.ts";
import {
  LegacyProjectRefResolver,
  PROJECT_NOT_LINKED_MESSAGE,
} from "../../../config/legacy-project-ref.service.ts";
import { mapLegacyHttpError } from "../../../shared/legacy-http-errors.ts";
import { LegacyLinkedProjectCache } from "../../../telemetry/legacy-linked-project-cache.service.ts";
import { LegacyTelemetryState } from "../../../telemetry/legacy-telemetry-state.service.ts";
import { defaultSchemas } from "../legacy-gen-schemas.ts";
import type { LegacyGenTanstackDbFlags } from "./tanstack-db.command.ts";
import {
  LegacyGenTanstackDbLocalStackNotRunningError,
  LegacyGenTanstackDbNetworkError,
  LegacyGenTanstackDbUnexpectedStatusError,
} from "./tanstack-db.errors.ts";
import {
  legacyDecodeOpenApiDefinitions,
  legacyGenerateTanstackDbFile,
  legacyMergeOpenApiDefinitions,
  type LegacyOpenApiDefinition,
} from "./tanstack-db.generators.ts";

const mapProjectOpenApiError = mapLegacyHttpError({
  networkError: LegacyGenTanstackDbNetworkError,
  statusError: LegacyGenTanstackDbUnexpectedStatusError,
  networkMessage: (cause) => `failed to get database schema: ${cause}`,
  statusMessage: (_status, body) => `failed to retrieve database schema: ${body}`,
});

export const legacyGenTanstackDb = Effect.fn("legacy.gen.tanstack-db")(function* (
  flags: LegacyGenTanstackDbFlags,
) {
  const output = yield* Output;
  const cliConfig = yield* LegacyCliConfig;
  const telemetryState = yield* LegacyTelemetryState;
  const platformApi = yield* LegacyPlatformApiFactory;
  const projectRef = yield* LegacyProjectRefResolver;
  const linkedProjectCache = yield* LegacyLinkedProjectCache;
  const httpClient = yield* HttpClient.HttpClient;

  yield* ensureMutuallyExclusive(
    ["local", "linked", "project-id"],
    [
      ...(flags.local ? ["local"] : []),
      ...(flags.linked ? ["linked"] : []),
      ...(Option.isSome(flags.projectId) ? ["project-id"] : []),
    ],
  );

  // `flags.schema` is already CSV-parsed and validated by
  // `Flag.mapTryCatch(legacyParseSchemaFlags)` in tanstack-db.command.ts.
  const requestedSchemas = flags.schema;

  const fetchLocalDefinitions = Effect.gen(function* () {
    const loaded = yield* loadProjectConfig(cliConfig.workdir);
    if (loaded === null) {
      return yield* Effect.fail(new Error("failed to load config: supabase/config.toml not found"));
    }
    const schemas =
      requestedSchemas.length > 0 ? requestedSchemas : defaultSchemas(loaded.config.api.schemas);
    const publishableKey =
      loaded.config.auth.publishable_key ?? loaded.config.auth.anon_key ?? defaultPublishableKey;
    const port = loaded.config.api.port;

    const fetchSchema = (schema: string) =>
      Effect.gen(function* () {
        let request = HttpClientRequest.get(`http://127.0.0.1:${port}/rest/v1/`).pipe(
          HttpClientRequest.setHeader("apikey", publishableKey),
          HttpClientRequest.setHeader("Accept-Profile", schema),
        );
        if (!publishableKey.startsWith("sb_")) {
          request = request.pipe(
            HttpClientRequest.setHeader("Authorization", `Bearer ${publishableKey}`),
          );
        }

        const response = yield* httpClient.execute(request).pipe(
          Effect.catch(() =>
            Effect.fail(
              new LegacyGenTanstackDbLocalStackNotRunningError({
                message: "supabase start is not running.",
              }),
            ),
          ),
        );
        if (response.status !== 200) {
          const body = yield* response.text.pipe(Effect.orElseSucceed(() => ""));
          return yield* Effect.fail(
            new LegacyGenTanstackDbUnexpectedStatusError({
              status: response.status,
              body,
              message: `failed to retrieve database schema: ${body}`,
            }),
          );
        }
        const rawBody = yield* response.json;
        return yield* legacyDecodeOpenApiDefinitions(rawBody);
      });

    const documents = yield* Effect.forEach(schemas, fetchSchema);
    return legacyMergeOpenApiDefinitions(documents);
  });

  const fetchRemoteDefinitions = (ref: string) =>
    Effect.gen(function* () {
      const api = yield* platformApi.make;
      const loaded =
        requestedSchemas.length > 0 ? null : yield* loadProjectConfig(cliConfig.workdir);
      const schemas =
        requestedSchemas.length > 0 ? requestedSchemas : defaultSchemas(loaded?.config.api.schemas);

      const documents = yield* Effect.forEach(schemas, (schema) =>
        api.v1
          .getDatabaseOpenapi({ ref, schema })
          .pipe(
            Effect.catch(mapProjectOpenApiError),
            Effect.andThen(legacyDecodeOpenApiDefinitions),
          ),
      );
      return legacyMergeOpenApiDefinitions(documents);
    }).pipe(Effect.ensuring(linkedProjectCache.cache(ref)));

  yield* Effect.gen(function* () {
    const definitions: Record<string, LegacyOpenApiDefinition> = yield* (() => {
      if (flags.local) {
        return fetchLocalDefinitions;
      }
      if (flags.linked) {
        return projectRef.resolve(Option.none()).pipe(Effect.andThen(fetchRemoteDefinitions));
      }
      if (Option.isSome(flags.projectId)) {
        return projectRef.resolve(flags.projectId).pipe(Effect.andThen(fetchRemoteDefinitions));
      }
      return projectRef.resolve(Option.none()).pipe(
        Effect.catch((cause) => {
          if (
            cause instanceof LegacyProjectNotLinkedError &&
            cause.message === PROJECT_NOT_LINKED_MESSAGE
          ) {
            return Effect.fail(new Error("Must specify one of --local, --linked, or --project-id"));
          }
          return Effect.fail(cause);
        }),
        Effect.andThen(fetchRemoteDefinitions),
      );
    })();

    const content = yield* legacyGenerateTanstackDbFile(definitions);
    yield* output.raw(content);
  }).pipe(Effect.ensuring(telemetryState.flush));
});
