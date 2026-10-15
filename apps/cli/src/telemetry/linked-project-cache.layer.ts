import { makeApiClient } from "@supabase/api/effect";
import { Effect, FileSystem, Layer, Option, Path, type Redacted } from "effect";
import * as HttpClient from "effect/http/HttpClient";

import { CommandCredentials } from "../auth/command-credentials.service.ts";
import { CommandSettings } from "../config/command-settings.service.ts";
import { IdentityStitch } from "../command-internal/identity-stitch.ts";
import { Analytics } from "../shared/telemetry/analytics.service.ts";
import { identifyProjectGroups } from "../shared/telemetry/identify-project-groups.ts";
import { legacyProjectStatePaths } from "../command-internal/legacy-project-state.paths.ts";
import { readLinkedProjectRef } from "../command-internal/project-link.ts";
import { currentProjectStateMode } from "../command-internal/project-state-mode.ts";
import { LinkedProjectCache } from "./linked-project-cache.service.ts";
import { block } from "../command-internal/command-permissions/model.ts";

/** `LinkedProjectCache`'s post-run fill. */
export const linkedProjectCache = block("linked-project-cache", [
  {
    operationId: "v1-get-project",
    kind: "best-effort",
    context:
      "an access token, no cached supabase/.temp/linked-project.json, and no supabase/.temp/project-ref naming a different project",
  },
]);

/**
 * Writes `<workdir>/supabase/.temp/linked-project.json` (legacy mode only) after a `--project-ref` has been
 * resolved. No write if the cache already exists (`supabase link` is authoritative), and any
 * API/filesystem/parse error is swallowed.
 *
 * Builds its own typed client per fill rather than consuming `CommandPlatformApi`, which
 * requires a stored token at construction; this layer skips quietly when there is none.
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
          // Stack mode keeps the parent project in `supabase/.link.json`, written by `link`.
          if ((yield* currentProjectStateMode) === "stack") return;
          const resolvedWorkdir = workdir ?? cliSettings.workdir;
          const cachePath = legacyProjectStatePaths(path, resolvedWorkdir).linkedProjectCache;
          const exists = yield* fs.exists(cachePath).pipe(Effect.orElseSucceed(() => false));
          yield* Effect.annotateCurrentSpan({ "cache.hit": exists });
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
          const fileRef = yield* readLinkedProjectRef(fs, path, resolvedWorkdir).pipe(
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

          const api = yield* makeApiClient(
            {
              baseUrl: apiUrl ?? cliSettings.apiUrl,
              accessToken: tokenOpt.value,
              userAgent: cliSettings.userAgent,
            },
            {
              transformClient: (client) =>
                Effect.succeed(
                  HttpClient.transform(client, (requestEffect) =>
                    requestEffect.pipe(Effect.tap(stitch)),
                  ),
                ),
            },
          ).pipe(Effect.provideService(HttpClient.HttpClient, httpClient));
          const project = yield* api.v1.getProject({ ref }, { retry: { maxRetries: 0 } });

          const linked = {
            ref: project.ref,
            name: project.name,
            organization_id: project.organization_id,
            organization_slug: project.organization_slug,
          };

          yield* fs.makeDirectory(path.dirname(cachePath), { recursive: true });
          yield* fs.writeFileString(cachePath, JSON.stringify(linked));

          yield* identifyProjectGroups(analytics, linked);
        }).pipe(Effect.withSpan("LinkedProjectCache.cache"), Effect.ignore),
    });
  }),
);
