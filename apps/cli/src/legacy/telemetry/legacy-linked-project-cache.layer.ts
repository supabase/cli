import { Effect, FileSystem, Layer, Option, Path, Redacted } from "effect";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";

import { LegacyCredentials } from "../auth/legacy-credentials.service.ts";
import { LegacyCliConfig } from "../config/legacy-cli-config.service.ts";
import { LegacyIdentityStitch } from "../shared/legacy-identity-stitch.ts";
import { Analytics } from "../../shared/telemetry/analytics.service.ts";
import { GroupOrganization, GroupProject } from "../../shared/telemetry/event-catalog.ts";
import { legacyTempPaths } from "../shared/legacy-temp-paths.ts";
import { LegacyLinkedProjectCache } from "./legacy-linked-project-cache.service.ts";

function readString(obj: unknown, key: string): string {
  if (typeof obj === "object" && obj !== null && key in obj) {
    const value = (obj as Record<string, unknown>)[key];
    return typeof value === "string" ? value : "";
  }
  return "";
}

/**
 * Writes `<workdir>/supabase/.temp/linked-project.json` after a `--project-ref`
 * has been resolved. Mirrors Go's `ensureProjectGroupsCached`
 * (`apps/cli-go/cmd/root.go:213-234`):
 *
 *  - No write if the cache already exists (`supabase link` is authoritative).
 *  - Best-effort: any API / filesystem / parse error is swallowed.
 *  - Body shape matches `LinkedProject` from
 *    `apps/cli-go/internal/telemetry/project.go:15-20`.
 *
 * Bypasses `LegacyPlatformApi`'s strict schema decode by calling the API
 * directly with `HttpClient`. The generated `V1ProjectWithDatabaseResponse`
 * schema enforces a 20-char project-ref length that the cli-e2e replay
 * fixtures (which store `__PROJECT_REF__` placeholders) cannot satisfy.
 * The cache only needs four string fields and doesn't validate them.
 */
export const legacyLinkedProjectCacheLayer = Layer.effect(
  LegacyLinkedProjectCache,
  Effect.gen(function* () {
    const httpClient = yield* HttpClient.HttpClient;
    const cliConfig = yield* LegacyCliConfig;
    const credentials = yield* LegacyCredentials;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const analytics = yield* Analytics;
    // Go's `ensureProjectGroupsCached` GETs `/v1/projects/{ref}` through
    // `GetSupabase()`'s identityTransport (`cmd/root.go:226`, `api.go:128-134`),
    // so the X-Gotrue-Id on that response stitches the session identity. For a
    // password-only `db lint`/`db advisors --linked` run this cache GET can be the
    // ONLY Management API response, so it must stitch too. Consume the single
    // per-command stitcher service (shared with the typed client + advisor GETs)
    // so the alias + persist fire at most once per command, matching Go's one
    // root-context `sync.Once`.
    const { stitch } = yield* LegacyIdentityStitch;

    return LegacyLinkedProjectCache.of({
      cache: (ref: string, workdir?: string) =>
        Effect.gen(function* () {
          const cachePath = legacyTempPaths(path, workdir ?? cliConfig.workdir).linkedProjectCache;
          const exists = yield* fs.exists(cachePath).pipe(Effect.orElseSucceed(() => false));
          if (exists) return;

          // Resolve token: env wins over keyring/file lookup (Go-parity).
          const tokenOpt = Option.isSome(cliConfig.accessToken)
            ? cliConfig.accessToken
            : yield* credentials.getAccessToken;
          if (Option.isNone(tokenOpt)) return;
          const token = Redacted.value(tokenOpt.value);

          const request = HttpClientRequest.get(`${cliConfig.apiUrl}/v1/projects/${ref}`).pipe(
            HttpClientRequest.setHeader("Authorization", `Bearer ${token}`),
            HttpClientRequest.setHeader("User-Agent", cliConfig.userAgent),
          );
          const response = yield* httpClient.execute(request);
          // Stitch identity from the response (Go's identityTransport fires on
          // every response regardless of status), before the status gate.
          yield* stitch(response);
          if (response.status !== 200) return;
          const body = yield* response.json;

          const linked = {
            ref: readString(body, "ref"),
            name: readString(body, "name"),
            organization_id: readString(body, "organization_id"),
            organization_slug: readString(body, "organization_slug"),
          };

          yield* fs.makeDirectory(path.dirname(cachePath), { recursive: true });
          yield* fs.writeFileString(cachePath, JSON.stringify(linked));

          // Go's CacheProjectAndIdentifyGroups (telemetry/project.go:66-88) does
          // not just write the file — on the same cache miss it also publishes the
          // org/project group metadata via GroupIdentify before the post-run
          // cli_command_executed capture. Reproduce both calls (same payload shape
          // as the link handler) so the first linked run after a port doesn't drop
          // the group properties Go sends. Best-effort like Go (wrapped in ignore).
          if (linked.organization_id.length > 0) {
            yield* analytics.groupIdentify(GroupOrganization, linked.organization_id, {
              organization_slug: linked.organization_slug,
            });
          }
          if (linked.ref.length > 0) {
            yield* analytics.groupIdentify(GroupProject, linked.ref, {
              name: linked.name,
              organization_slug: linked.organization_slug,
            });
          }
        }).pipe(Effect.ignore),
    });
  }),
);
