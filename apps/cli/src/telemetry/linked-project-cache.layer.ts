import { Effect, FileSystem, Layer, Option, Path, Redacted } from "effect";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";

import { CommandCredentials } from "../auth/command-credentials.service.ts";
import { CommandSettings } from "../config/command-settings.service.ts";
import { IdentityStitch } from "../command-internal/identity-stitch.ts";
import { Analytics } from "../shared/telemetry/analytics.service.ts";
import { GroupOrganization, GroupProject } from "../shared/telemetry/event-catalog.ts";
import { readProjectRefFile, tempPaths } from "../command-internal/temp-paths.ts";
import { LinkedProjectCache } from "./linked-project-cache.service.ts";

function readString(obj: unknown, key: string): string {
  if (typeof obj === "object" && obj !== null && key in obj) {
    const value = (obj as Record<string, unknown>)[key];
    return typeof value === "string" ? value : "";
  }
  return "";
}

/**
 * Writes `<workdir>/supabase/.temp/linked-project.json` after a `--project-ref` has been
 * resolved. No write if the cache already exists (`supabase link` is authoritative), and any
 * API/filesystem/parse error is swallowed.
 *
 * Bypasses `CommandPlatformApi`'s strict schema decode by calling the API directly with
 * `HttpClient`. The generated `V1ProjectWithDatabaseResponse` schema enforces a 20-char
 * project-ref length that the cli-e2e replay fixtures (which store `__PROJECT_REF__`
 * placeholders) cannot satisfy; the cache only needs four string fields and doesn't validate them.
 *
 * Also skips the write when `<workdir>/supabase/.temp/project-ref` exists, is non-empty, and
 * names a different ref than `ref` — see the inline comment at the check itself for the failure
 * mode this closes. This cache feeds `resolveLinkedParentRef`'s parent chain.
 */
export const linkedProjectCacheLayer = Layer.effect(
  LinkedProjectCache,
  Effect.gen(function* () {
    const httpClient = yield* HttpClient.HttpClient;
    const cliSettings = yield* CommandSettings;
    const credentials = yield* CommandCredentials;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const analytics = yield* Analytics;
    // The X-Gotrue-Id on this GET's response stitches the session identity — for a password-only
    // `db lint`/`db advisors --linked` run, this cache GET can be the only Management API
    // response, so it must stitch too. Consumes the single per-command stitcher service (shared
    // with the typed client + advisor GETs) so the alias + persist fire at most once per command.
    const { stitch } = yield* IdentityStitch;

    return LinkedProjectCache.of({
      cache: (
        ref: string,
        workdir?: string,
        apiUrl?: string,
        accessToken?: Option.Option<Redacted.Redacted<string>>,
      ) =>
        Effect.gen(function* () {
          const resolvedWorkdir = workdir ?? cliSettings.workdir;
          const cachePath = tempPaths(path, resolvedWorkdir).linkedProjectCache;
          const exists = yield* fs.exists(cachePath).pipe(Effect.orElseSucceed(() => false));
          if (exists) return;

          // The cache must describe the linked workdir's own state, not whatever ref the calling
          // command happens to have resolved: a mid-flight `link --project-ref B` failure still
          // reaches this fill via `Effect.ensuring`, and if `getProject(B)` returns 200 (e.g. B
          // is merely paused, not gone/forbidden), this would otherwise cache B as the linked
          // project even though `project-ref` itself was never updated to B — `link`'s own
          // mandatory write happens before this fill can ever fire, so a `project-ref` naming
          // something else here means the workdir is still actually linked to that something
          // else. Skip the write entirely when the file names a different ref. A file that's
          // absent entirely falls through to the write below — the read side
          // (`resolveLinkedParentRef`) already refuses to trust a cache with no `project-ref`
          // file at all, so there is nothing to protect there yet.
          const fileRef = yield* readProjectRefFile(fs, path, resolvedWorkdir).pipe(
            Effect.orElseSucceed(() => Option.none<string>()),
          );
          if (Option.isSome(fileRef) && fileRef.value !== ref) return;

          // An explicit reconciled-profile token wins outright (`Some` → use, `None` → the
          // reconciled profile has no token, so skip rather than fall back to a stale profile's
          // token); otherwise env wins over keyring/file lookup.
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
          // Stitch identity from the response before the status gate, regardless of status.
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

          // On the same cache miss, also publish the org/project group metadata via
          // `groupIdentify` (same payload shape as the link handler) before the post-run
          // `cli_command_executed` capture. Best-effort, wrapped in `Effect.ignore` below.
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
