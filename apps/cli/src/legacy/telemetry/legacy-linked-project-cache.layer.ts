import { Effect, FileSystem, Layer, Option, Path, Redacted } from "effect";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";

import { LegacyCredentials } from "../auth/legacy-credentials.service.ts";
import { LegacyCliSettings } from "../config/legacy-cli-settings.service.ts";
import { LegacyIdentityStitch } from "../shared/legacy-identity-stitch.ts";
import { Analytics } from "../../shared/telemetry/analytics.service.ts";
import { GroupOrganization, GroupProject } from "../../shared/telemetry/event-catalog.ts";
import { legacyReadProjectRefFile, legacyTempPaths } from "../shared/legacy-temp-paths.ts";
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
 *
 * DELIBERATE TS DIVERGENCE FROM GO (PR #6168 review): unlike
 * `ensureProjectGroupsCached`, which unconditionally caches whatever `ref`
 * it's given, this additionally skips the write when `<workdir>/supabase/.temp/project-ref`
 * exists, is non-empty, and names a DIFFERENT ref than `ref` — see the inline
 * comment at the check itself for the exact failure mode this closes. This
 * cache now feeds `legacyResolveLinkedParentRef`'s parent chain (CLI-2167
 * follow-up), so correctness there is prioritized over exact
 * telemetry-cache parity with Go (Go-authority scoping, ADR 0016) — Go never
 * reads this file back for anything, so this file has no comparable
 * behavior to preserve there.
 */
export const legacyLinkedProjectCacheLayer = Layer.effect(
  LegacyLinkedProjectCache,
  Effect.gen(function* () {
    const httpClient = yield* HttpClient.HttpClient;
    const cliSettings = yield* LegacyCliSettings;
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
      cache: (
        ref: string,
        workdir?: string,
        apiUrl?: string,
        accessToken?: Option.Option<Redacted.Redacted<string>>,
      ) =>
        Effect.gen(function* () {
          const resolvedWorkdir = workdir ?? cliSettings.workdir;
          const cachePath = legacyTempPaths(path, resolvedWorkdir).linkedProjectCache;
          const exists = yield* fs.exists(cachePath).pipe(Effect.orElseSucceed(() => false));
          if (exists) return;

          // The cache must describe the LINKED WORKDIR's own state, not
          // whatever ref the calling command happens to have resolved (PR
          // #6168 review): a mid-flight `link --project-ref B` failure still
          // reaches this fill via `Effect.ensuring`, and if `getProject(B)`
          // returns 200 (e.g. B is merely paused, not gone/forbidden), this
          // would otherwise cache B as the linked project even though
          // `project-ref` itself was never updated to B — `link`'s own
          // mandatory write happens BEFORE this fill can ever fire, so a
          // `project-ref` naming something else here means the workdir is
          // still actually linked to that something else. Skip the write
          // entirely when the file names a DIFFERENT ref: a deliberate TS
          // divergence from Go's `ensureProjectGroupsCached`, which caches
          // whatever ref it's given unconditionally — this cache now feeds
          // `legacyResolveLinkedParentRef`'s parent chain, so correctness
          // there outweighs 1:1 telemetry-cache parity (Go-authority
          // scoping, ADR 0016). A file that's absent entirely keeps today's
          // behavior (falls through to the write below) — the read side
          // (`legacyResolveLinkedParentRef`) already refuses to trust a
          // cache with no `project-ref` file at all, so there is nothing to
          // protect there yet.
          const fileRef = yield* legacyReadProjectRefFile(fs, path, resolvedWorkdir).pipe(
            Effect.orElseSucceed(() => Option.none<string>()),
          );
          if (Option.isSome(fileRef) && fileRef.value !== ref) return;

          // Resolve token: an explicit reconciled-profile token wins outright
          // (Some → use, None → the reconciled profile HAS no token, so skip
          // like Go's failed lookup — never fall back to the stale profile's
          // token, review r3684524241); otherwise env wins over keyring/file
          // lookup (Go-parity).
          const tokenOpt =
            accessToken ??
            (Option.isSome(cliSettings.accessToken)
              ? cliSettings.accessToken
              : yield* credentials.getAccessToken);
          if (Option.isNone(tokenOpt)) return;
          const token = Redacted.value(tokenOpt.value);

          const request = HttpClientRequest.get(
            `${apiUrl ?? cliSettings.apiUrl}/v1/projects/${ref}`,
          ).pipe(
            HttpClientRequest.setHeader("Authorization", `Bearer ${token}`),
            HttpClientRequest.setHeader("User-Agent", cliSettings.userAgent),
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
