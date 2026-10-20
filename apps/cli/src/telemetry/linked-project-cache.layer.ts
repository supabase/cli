import { makeApiClient } from "@supabase/api/effect";
import { Effect, FileSystem, Layer, Option, Path, type Redacted, Schema } from "effect";
import * as HttpClient from "effect/http/HttpClient";
import { publish } from "@supabase/stack/effect";

import { CommandCredentials } from "../auth/command-credentials.service.ts";
import { CommandSettings } from "../config/command-settings.service.ts";
import { PROJECT_REF_PATTERN } from "../config/remote-target.service.ts";
import { IdentityStitch } from "../command-internal/identity-stitch.ts";
import { Analytics } from "../shared/telemetry/analytics.service.ts";
import { identifyProjectGroups } from "../shared/telemetry/identify-project-groups.ts";
import { legacyProjectStatePaths } from "../command-internal/legacy-project-state.paths.ts";
import { readLinkSnapshotSoft } from "../command-internal/link-snapshot.ts";
import { currentProjectStateMode } from "../command-internal/project-state-mode.ts";
import { LinkedProjectCache } from "./linked-project-cache.service.ts";
import { block } from "../command-internal/command-permissions/model.ts";

/** `LinkedProjectCache`'s post-run fill. */
export const linkedProjectCache = block("linked-project-cache", [
  {
    operationId: "v1-get-project",
    kind: "best-effort",
    context:
      "an access token, no cached project metadata (supabase/.temp/linked-project.json, or $SUPABASE_HOME/project-cache/<ref>.json in stack mode), and no linked ref naming a different project",
  },
]);

const encodeLinkedProjectCache = Schema.encodeEffect(
  Schema.fromJsonString(
    Schema.Struct({
      ref: Schema.String,
      name: Schema.String,
      organization_id: Schema.String,
      organization_slug: Schema.String,
    }),
  ),
);

/**
 * Writes the project's metadata after a `--project-ref` has been resolved: `<workdir>/supabase/.temp/linked-project.json`
 * in legacy mode, or `$SUPABASE_HOME/project-cache/<ref>.json` in stack mode, so a stack-mode
 * checkout never gains a `.temp`. No write if the cache already exists (`supabase link` is
 * authoritative in legacy mode), and any API/filesystem/parse error is swallowed.
 *
 * Builds its own typed client per fill rather than consuming `CommandPlatformApi`, which
 * requires a stored token at construction; this layer skips quietly when there is none.
 *
 * The per-ref stack file is a "group-identify once per ref" marker: its presence skips the
 * `v1-get-project` call and the `groupIdentify` on later runs, and nothing else reads it. It is
 * published atomically so a concurrent run never sees a partial file.
 *
 * In legacy mode it also skips the write when the linked ref names a different project than
 * `ref` — see the inline comment at the check itself for the failure mode this closes. That
 * cache feeds `RemoteTarget.parent`.
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
          const stackMode = (yield* currentProjectStateMode) === "stack";
          // The ref names the cache file, so only a well-formed one may reach the path.
          if (stackMode && !PROJECT_REF_PATTERN.test(ref)) return;
          const resolvedWorkdir = workdir ?? cliSettings.workdir;
          const cachePath = stackMode
            ? path.join(cliSettings.supabaseHome, "project-cache", `${ref}.json`)
            : legacyProjectStatePaths(path, resolvedWorkdir).linkedProjectCache;
          const exists = yield* fs.exists(cachePath).pipe(Effect.orElseSucceed(() => false));
          yield* Effect.annotateCurrentSpan({ "cache.hit": exists });
          if (exists) return;

          // The legacy cache must describe the linked workdir's own state, not whatever ref the
          // calling command happens to have resolved: a mid-flight `link --project-ref B` failure
          // still reaches this fill via `Effect.ensuring`, and if `getProject(B)` returns 200
          // (e.g. B is merely paused, not gone/forbidden), this would otherwise cache B as the
          // linked project even though the linked ref itself was never updated to B. Skip the
          // write when the link names a different ref. An absent link falls through to the write
          // below, since `RemoteTarget.parent` already refuses to trust a cache with no linked
          // ref. The per-ref stack cache is keyed by `ref`, so it cannot describe another project.
          if (!stackMode) {
            const linkedRef = (yield* readLinkSnapshotSoft(fs, path, resolvedWorkdir)).ref;
            if (Option.isSome(linkedRef) && linkedRef.value !== ref) return;
          }

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
          yield* publish(fs, path, {
            target: cachePath,
            content: yield* encodeLinkedProjectCache(linked),
          });

          yield* identifyProjectGroups(analytics, linked);
        }).pipe(Effect.withSpan("LinkedProjectCache.cache"), Effect.ignore),
    });
  }),
);
