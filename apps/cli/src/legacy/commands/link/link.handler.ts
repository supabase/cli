import type { ApiClient } from "@supabase/api/effect";
import { Effect, FileSystem, Option, Path } from "effect";
import type { PlatformError } from "effect/PlatformError";
import * as HttpClientError from "effect/unstable/http/HttpClientError";

import { LegacyPlatformApi } from "../../auth/legacy-platform-api.service.ts";
import { LegacyCliConfig } from "../../config/legacy-cli-config.service.ts";
import { LegacyProjectRefResolver } from "../../config/legacy-project-ref.service.ts";
import { LegacyLinkedProjectCache } from "../../telemetry/legacy-linked-project-cache.service.ts";
import { LegacyTelemetryState } from "../../telemetry/legacy-telemetry-state.service.ts";
import { Output } from "../../../shared/output/output.service.ts";
import { Analytics } from "../../../shared/telemetry/analytics.service.ts";
import { withAnalyticsContext } from "../../../shared/telemetry/analytics-context.ts";
import {
  EventProjectLinked,
  GroupOrganization,
  GroupProject,
} from "../../../shared/telemetry/event-catalog.ts";
import { legacyDashboardUrl } from "../../shared/legacy-profile.ts";
import { legacyMapTenantApiKeysError } from "../../shared/legacy-get-tenant-api-keys.ts";
import { sanitizeLegacyErrorBody } from "../../shared/legacy-http-errors.ts";
import { legacyLinkServicesCore } from "../../shared/legacy-link-services-core.ts";
import { legacyExtractServiceKeys } from "../../shared/legacy-tenant-keys.ts";
import { legacyTempPaths } from "../../shared/legacy-temp-paths.ts";
import {
  LegacyLinkApiKeysNetworkError,
  LegacyLinkAuthTokenError,
  LegacyLinkMissingKeyError,
  LegacyLinkProjectStatusError,
  LegacyLinkProjectStatusNetworkError,
  LegacyProjectPausedError,
} from "./link.errors.ts";
import type { LegacyLinkFlags } from "./link.command.ts";

type LegacyLinkProject = Effect.Success<ReturnType<ApiClient["v1"]["getProject"]>>;

// Classify a `getProject` failure: a 404 means the project is a branch (resolve
// to `None`, link continues); any other status surfaces the body; transport
// failures surface a network error. Mirrors `checkRemoteProjectStatus`
// (`link.go:240-253`).
const classifyProjectError = (
  cause: unknown,
): Effect.Effect<
  Option.Option<LegacyLinkProject>,
  LegacyLinkProjectStatusError | LegacyLinkProjectStatusNetworkError
> => {
  if (HttpClientError.isHttpClientError(cause) && cause.response !== undefined) {
    const status = cause.response.status;
    if (status === 404) {
      return Effect.succeedNone;
    }
    return cause.response.text.pipe(
      Effect.orElseSucceed(() => ""),
      // Cap + strip control chars, matching `mapLegacyHttpError`'s defence-in-depth
      // so an oversized / control-char body can't bloat JSON output or inject ANSI.
      Effect.map(sanitizeLegacyErrorBody),
      Effect.flatMap((body) =>
        Effect.fail(
          new LegacyLinkProjectStatusError({
            status,
            body,
            message: `Unexpected error retrieving remote project status: ${body}`,
          }),
        ),
      ),
    );
  }
  return Effect.fail(
    new LegacyLinkProjectStatusNetworkError({
      message: `failed to retrieve remote project status: ${String(cause)}`,
    }),
  );
};

type WriteTempFile = (filePath: string, content: string) => Effect.Effect<void, PlatformError>;

const mapApiKeysError = legacyMapTenantApiKeysError({
  networkError: LegacyLinkApiKeysNetworkError,
  statusError: LegacyLinkAuthTokenError,
});

export const legacyLink = Effect.fn("legacy.link")(function* (flags: LegacyLinkFlags) {
  const output = yield* Output;
  const api = yield* LegacyPlatformApi;
  const cliConfig = yield* LegacyCliConfig;
  const resolver = yield* LegacyProjectRefResolver;
  const linkedProjectCache = yield* LegacyLinkedProjectCache;
  const telemetryState = yield* LegacyTelemetryState;
  const analytics = yield* Analytics;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const ref = yield* resolver.resolveForLink(flags.projectRef);
  const paths = legacyTempPaths(path, cliConfig.workdir);

  const writeTempFile: WriteTempFile = (filePath, content) =>
    fs
      .makeDirectory(path.dirname(filePath), { recursive: true })
      .pipe(Effect.andThen(() => fs.writeFileString(filePath, content)));

  // Mirror Go's PersistentPostRun (`apps/cli-go/cmd/root.go:176`): persist the
  // linked-project cache and telemetry state whether the link succeeds or fails.
  // `link` itself writes `linked-project.json` on success (below), so `cache`
  // only fires for the failure / 404 paths.
  yield* Effect.gen(function* () {
    // 1. Check remote project status (404 tolerated for branch projects).
    const project = yield* api.v1
      .getProject({ ref })
      .pipe(Effect.asSome, Effect.catch(classifyProjectError));

    if (Option.isSome(project)) {
      const status = project.value.status;
      if (status === "INACTIVE") {
        return yield* Effect.fail(
          new LegacyProjectPausedError({
            message: "project is paused",
            suggestion: `An admin must unpause it from the Supabase dashboard at ${legacyDashboardUrl(
              cliConfig.profile,
            )}/project/${ref}`,
          }),
        );
      }
      if (status !== "ACTIVE_HEALTHY") {
        yield* output.raw(
          `WARNING: Project status is ${status} instead of Active Healthy. Some operations might fail.\n`,
          "stderr",
        );
      }
      // Update postgres image version to match the remote project (link.go:269).
      const version = project.value.database.version;
      if (version.length > 0) {
        yield* writeTempFile(paths.postgresVersion, version);
      }
    }

    // 2. Resolve service keys (auth check).
    const keys = yield* api.v1
      .getProjectApiKeys({ ref, reveal: true })
      .pipe(Effect.catch(mapApiKeysError));
    const { anon, serviceRole } = legacyExtractServiceKeys(keys);
    if (anon.length === 0 && serviceRole.length === 0) {
      return yield* Effect.fail(new LegacyLinkMissingKeyError({ message: "Anon key not found." }));
    }

    // 3. Link services — best-effort, using the service-role key for tenant probes.
    yield* legacyLinkServicesCore({
      ref,
      serviceKey: serviceRole,
      skipPooler: flags.skipPooler,
      workdir: cliConfig.workdir,
    });

    // 4. Save project ref (mandatory — a write failure fails the command).
    yield* writeTempFile(paths.projectRef, ref);

    // 5. Telemetry + linked-project cache (only for resolvable projects, i.e.
    // not the 404 branch path). `link.go:40-67`.
    if (Option.isSome(project)) {
      const p = project.value;
      // SaveLinkedProject — best-effort (debug-logged in Go, never fatal).
      yield* writeTempFile(
        paths.linkedProjectCache,
        JSON.stringify({
          ref: p.ref,
          name: p.name,
          organization_id: p.organization_id,
          organization_slug: p.organization_slug,
        }),
      ).pipe(Effect.ignore);

      const groups = { organization: p.organization_id, project: p.ref } as const;
      if (p.organization_id.length > 0) {
        yield* analytics.groupIdentify(GroupOrganization, p.organization_id, {
          organization_slug: p.organization_slug,
        });
      }
      if (p.ref.length > 0) {
        yield* analytics.groupIdentify(GroupProject, p.ref, {
          name: p.name,
          organization_slug: p.organization_slug,
        });
      }
      yield* analytics.capture(EventProjectLinked, {}).pipe(withAnalyticsContext({ groups }));
    }

    // 6. PostRun: `Finished supabase link.` to stdout (text), structured success
    // otherwise.
    if (output.format === "text") {
      yield* output.raw("Finished supabase link.\n");
    } else {
      yield* output.success("", { project_ref: ref });
    }
  }).pipe(Effect.ensuring(linkedProjectCache.cache(ref)), Effect.ensuring(telemetryState.flush));
});
