import { dirname } from "node:path";
import { findCliProjectRoot } from "@supabase/config/effect";
import { loadCliConfig } from "@supabase/config/internal";
import { Effect, FileSystem, Option, Path } from "effect";

import { LegacyPlatformApi } from "../../../auth/legacy-platform-api.service.ts";
import { LegacyCliSettings } from "../../../config/legacy-cli-settings.service.ts";
import { LegacyLinkedProjectCache } from "../../../telemetry/legacy-linked-project-cache.service.ts";
import { LegacyTelemetryState } from "../../../telemetry/legacy-telemetry-state.service.ts";
import { legacyResolveYesWithProjectEnv } from "../../../../shared/legacy/global-flags.ts";
import { CONTEXT_CANCELED_MESSAGE } from "../../../../shared/output/errors.ts";
import { Output } from "../../../../shared/output/output.service.ts";
import {
  legacyAssertDecryptableSecrets,
  legacyLoadProjectEnv,
} from "../../../shared/legacy-db-config.toml-read.ts";
import { legacyClassifyProjectLookupError } from "../../../shared/legacy-branch-target.ts";
import { mapLegacyHttpError } from "../../../shared/legacy-http-errors.ts";
import { legacyPromptYesNo } from "../../../../shared/legacy/legacy-prompt-yes-no.ts";
import { legacyCollectDotenvPrivateKeys } from "../../../shared/legacy-vault-decrypt.ts";
import { legacyResolveConfigTargetRef } from "../config.branch-target.ts";
import { apiSubsetFromConfig, apiToUpdateBody, diffApiWithRemote } from "./config-sync/api.sync.ts";
import {
  applyRemoteAuthConfig,
  authEnabled,
  authSubsetFromConfig,
  authToUpdateBody,
  diffAuth,
  disableMfaPhone,
  disableMfaWebauthn,
  mfaPhoneNewlyEnabled,
  mfaWebauthnNewlyEnabled,
} from "./config-sync/auth.sync.ts";
import {
  dbSettingsFromConfig,
  dbSettingsToUpdateBody,
  diffDbSettingsWithRemote,
  diffNetworkRestrictionsWithRemote,
  diffSslEnforcementWithRemote,
  networkRestrictionsFromConfig,
  networkRestrictionsToUpdateBody,
  sslEnforcementFromConfig,
  sslEnforcementToUpdateBody,
} from "./config-sync/db.sync.ts";
import { experimentalWebhooksEnabled } from "./config-sync/experimental.sync.ts";
import {
  diffStorageWithRemote,
  storageSubsetFromConfig,
  storageToUpdateBody,
} from "./config-sync/storage.sync.ts";
import { loadAuthEmailContent } from "./config-sync/config-sync.auth-email-content.ts";
import {
  legacyConfigPushBranchPromptLabel,
  legacyConfigPushPayloadFields,
  legacyConfigPushTargetLines,
} from "./push.format.ts";
import { legacyResolveConfigPushTarget } from "./push.branch-target.ts";
import { getCostMatrix } from "./push.cost-matrix.ts";
import { legacyPresenceIn } from "./push.raw-presence.ts";
import {
  LegacyConfigPushApiReadNetworkError,
  LegacyConfigPushApiReadStatusError,
  LegacyConfigPushApiUpdateNetworkError,
  LegacyConfigPushApiUpdateStatusError,
  LegacyConfigPushAuthReadNetworkError,
  LegacyConfigPushAuthReadStatusError,
  LegacyConfigPushAuthUpdateNetworkError,
  LegacyConfigPushAuthUpdateStatusError,
  LegacyConfigPushBranchNotFoundError,
  LegacyConfigPushBranchNotLinkedError,
  LegacyConfigPushBranchNotReadyError,
  LegacyConfigPushBranchResolveNetworkError,
  LegacyConfigPushBranchResolveStatusError,
  LegacyConfigPushCancelledError,
  LegacyConfigPushDbReadNetworkError,
  LegacyConfigPushDbReadStatusError,
  LegacyConfigPushDbUpdateNetworkError,
  LegacyConfigPushDbUpdateStatusError,
  LegacyConfigPushEnableWebhookNetworkError,
  LegacyConfigPushEnableWebhookStatusError,
  LegacyConfigPushLoadConfigError,
  LegacyConfigPushNetworkRestrictionsReadNetworkError,
  LegacyConfigPushNetworkRestrictionsReadStatusError,
  LegacyConfigPushNetworkRestrictionsUpdateNetworkError,
  LegacyConfigPushNetworkRestrictionsUpdateStatusError,
  LegacyConfigPushParentRefInvalidError,
  LegacyConfigPushProjectLookupNetworkError,
  LegacyConfigPushProjectLookupStatusError,
  LegacyConfigPushSslEnforcementReadNetworkError,
  LegacyConfigPushSslEnforcementReadStatusError,
  LegacyConfigPushSslEnforcementUpdateNetworkError,
  LegacyConfigPushSslEnforcementUpdateStatusError,
  LegacyConfigPushStorageReadNetworkError,
  LegacyConfigPushStorageReadStatusError,
  LegacyConfigPushStorageUpdateNetworkError,
  LegacyConfigPushStorageUpdateStatusError,
} from "./push.errors.ts";
import type { LegacyConfigPushFlags } from "./push.command.ts";
import type { LegacyConfigPushServiceResult } from "./push.types.ts";

const readStatusMessage = (status: number, body: string) => `unexpected status ${status}: ${body}`;

const mapPushBranchResolveError = mapLegacyHttpError({
  networkError: LegacyConfigPushBranchResolveNetworkError,
  statusError: LegacyConfigPushBranchResolveStatusError,
  networkMessage: (cause) => `failed to resolve branch: ${cause}`,
  statusMessage: readStatusMessage,
});

// Classify a `getProject` failure for the target-echo probe (CLI-2168): a
// 404 means `ref` is a branch (resolves to `None`, `legacyResolveConfigPushTarget`
// continues its own best-effort recovery); any other status/network failure
// is a hard failure for this command.
const classifyPushProjectLookupError = legacyClassifyProjectLookupError({
  networkError: LegacyConfigPushProjectLookupNetworkError,
  statusError: LegacyConfigPushProjectLookupStatusError,
  networkMessage: (cause) => `failed to retrieve project status: ${cause}`,
  statusMessage: (status, body) => `unexpected project lookup status ${status}: ${body}`,
});

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export const legacyConfigPush = Effect.fn("legacy.config.push")(function* (
  flags: LegacyConfigPushFlags,
) {
  const output = yield* Output;
  const api = yield* LegacyPlatformApi;
  const cliSettings = yield* LegacyCliSettings;
  const linkedProjectCache = yield* LegacyLinkedProjectCache;
  const telemetryState = yield* LegacyTelemetryState;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  // `--yes` OR `SUPABASE_YES`. `config push` imports `supabase/.env` before
  // the confirmation prompt reads the yes flag, so a `SUPABASE_YES` set only
  // in `supabase/.env` auto-confirms. Resolve against the project env, not
  // just the flag + shell env. Load it from the resolved project root
  // (walking up, same as `loadCliConfig` below and the workdir change
  // before config load), so a push from a subdirectory still reads the
  // project root's `supabase/.env`.
  // Resolved against `cliSettings.workdir` — the same root the project-ref
  // resolver and the linked-project cache use — so `--workdir ../other`
  // pushes `../other`'s config.toml, never the invoking directory's file to
  // another root's linked project.
  const projectRoot = (yield* findCliProjectRoot(cliSettings.workdir)) ?? cliSettings.workdir;
  const projectEnv = yield* legacyLoadProjectEnv(fs, path, projectRoot);
  const yes = yield* legacyResolveYesWithProjectEnv(projectEnv);
  // dotenvx private keys for decrypting `encrypted:` secrets, from the shell
  // + project env — same source/precedence as `legacy-db-config.toml-read.ts`
  // (`process.env` wins over `supabase/.env`).
  const dotenvPrivateKeys = legacyCollectDotenvPrivateKeys({ ...projectEnv, ...process.env });
  // Only reached by `legacyAssertDecryptableSecrets` below for an `env(VAR)` literal that
  // survives `loaded.document`'s own (`@supabase/config`) interpolation pass unresolved — i.e.
  // when this wider env source resolves `VAR` but `@supabase/config`'s
  // narrower one (`supabase/.env`/`.env.local` only) didn't. Practically
  // unreachable in the same narrow way the CLI-1489 comment below already documents for
  // non-secret fields; kept for parity with the shared function's other caller
  // (`legacy-db-config.toml-read.ts`, whose pre-interpolation document relies on this).
  const secretEnvLookup = (name: string): string | undefined =>
    process.env[name] ?? projectEnv[name];

  // `--project-ref` accepts a project ref, or the name (or UUID) of a branch
  // of the linked project — `link`'s/`config diff`'s settled vocabulary
  // (CLI-2167/CLI-2289). An empty `--project-ref` value is absent, mirroring
  // the resolver's own rule.
  const requestedRef = Option.filter(flags.projectRef, (value) => value.length > 0);

  // Written once ref resolution succeeds, so the linked-project cache
  // finalizer below only fires for invocations that got that far — mirrors
  // `diff.handler.ts`'s `resolvedRef` pattern (Legacy Shell Invariant #1):
  // every failure path from here on, including branch/UUID resolution,
  // stays inside this file's single `Effect.ensuring`-wrapped block below.
  let resolvedRef: string | undefined;

  const loadPushConfig = (projectRef: string | undefined) =>
    loadCliConfig(cliSettings.workdir, { projectRef, goViperCompat: true }).pipe(
      Effect.catchTag(
        "CliConfigParseError",
        (cause) =>
          new LegacyConfigPushLoadConfigError({
            message: `failed to parse supabase/config.toml: ${String(cause.cause)}`,
          }),
      ),
      Effect.catchTag(
        "DuplicateRemoteProjectIdError",
        (cause) => new LegacyConfigPushLoadConfigError({ message: cause.message }),
      ),
      Effect.flatMap((loaded) =>
        loaded === null
          ? Effect.fail(
              new LegacyConfigPushLoadConfigError({
                message: "failed to read supabase/config.toml: file not found",
              }),
            )
          : Effect.succeed(loaded),
      ),
    );

  yield* Effect.gen(function* () {
    // 1. Load config.toml with no ref override (TOML parse error aborts
    // before any network call — including the branch/UUID resolution
    // below).
    //
    // NOTE (CLI-1489): `config push` needs the fully decoded config (every
    // service subset), so it uses `loadCliConfig` rather than the tolerant
    // `legacy-db-config.toml-read.ts` subtree reader. `loadCliConfig` raises
    // `CliConfigParseError` on `env(...)` refs over numeric/bool fields,
    // which Go resolves transparently. Switch to the fixed decoder once
    // CLI-1489 lands; until then this is the conscious tradeoff for this command.
    let loaded = yield* loadPushConfig(undefined);

    // 2. Resolve the push target. `--project-ref` accepts a project ref, or
    // the name (or UUID) of a branch of the linked project (CLI-2167/CLI-2289) —
    // hoisted to `config.branch-target.ts` (Hoist Before You Duplicate,
    // shared with `config diff`). This is ALSO where `resolvedRef` is set,
    // so every one of the hoisted resolver's failure paths (not linked,
    // invalid parent, not found, not ready, network/status) still flushes
    // telemetry and, once a ref is known, writes the linked-project cache.
    const resolved = yield* legacyResolveConfigTargetRef(requestedRef, {
      notLinkedError: (opts) => new LegacyConfigPushBranchNotLinkedError(opts),
      parentRefInvalidError: (opts) => new LegacyConfigPushParentRefInvalidError(opts),
      branchNotFoundError: (opts) => new LegacyConfigPushBranchNotFoundError(opts),
      branchNotReadyError: (opts) => new LegacyConfigPushBranchNotReadyError(opts),
      mapResolveError: {
        mapGetError: mapPushBranchResolveError,
        mapFindError: mapPushBranchResolveError,
      },
    });
    const ref = resolved.ref;
    resolvedRef = ref;

    // 3. Apply the matching `[remotes.<name>]` overlay (ADR 0018) now that
    // the target ref is known. Only a config whose remotes actually MATCH
    // the resolved ref reloads (checked on the already-loaded,
    // env-interpolated document) — every other config keeps the step-1
    // load. A duplicate `project_id` across remotes surfaces an established
    // error message.
    const remotes = loaded.document?.["remotes"];
    const remoteMatchesRef =
      isRecord(remotes) &&
      Object.values(remotes).some((remote) => isRecord(remote) && remote["project_id"] === ref);
    if (remoteMatchesRef) {
      loaded = yield* loadPushConfig(ref);
    }
    // Printed once the final (possibly reloaded) config is known, before any
    // other command output.
    if (loaded.appliedRemote !== undefined) {
      yield* output.raw(`Loading config override: [remotes.${loaded.appliedRemote}]\n`, "stderr");
    }
    const projectId = ref;
    const config = loaded.config;

    // 3b. Assert every `config.Secret`-typed `encrypted:` value in the
    // document (not just auth.*) can be decrypted — this must run before the
    // cost matrix is fetched or any service is touched. An undecryptable
    // secret anywhere in the document (even one `config push` never itself
    // pushes, e.g. `studio.openai_api_key`) aborts here with a
    // `failed to parse config: <cause>` message, before any remote service
    // is read or updated.
    //
    // `loaded.document` has already had deprecated
    // `auth.external.{linkedin,slack}` blocks stripped by `@supabase/config`
    // (`normalizeDeprecatedExternalProviders`), but the decrypt hook runs at
    // decode time — before the later `external.validate()` deletes those
    // blocks — so an `encrypted:` secret hiding in one of them still aborts
    // the load. Fold `removedDeprecatedExternalProviders` back into a
    // synthetic `auth.external` view and scan that too, reusing the same
    // path list rather than a second scanner.
    const secretError =
      legacyAssertDecryptableSecrets(loaded.document, secretEnvLookup, dotenvPrivateKeys) ??
      legacyAssertDecryptableSecrets(
        { auth: { external: loaded.removedDeprecatedExternalProviders ?? {} } },
        secretEnvLookup,
        dotenvPrivateKeys,
      );
    if (secretError !== undefined) {
      return yield* new LegacyConfigPushLoadConfigError({ message: secretError });
    }

    // Optional `*pointer` sections (ssl_enforcement, image_transformation,
    // s3_protocol) are defaulted-present by @supabase/config and cannot be
    // recovered from the decoded config, so we inspect the raw (merged)
    // document to restore nil-pointer skip semantics — including sections a
    // matching `[remotes.*]` block introduces.
    const presence = legacyPresenceIn(loaded.document);

    // Config lives at <projectRoot>/supabase/config.{toml,json}.
    const projectRoot = dirname(dirname(loaded.path));

    // Email content validation runs during config load, before any network call.
    const authEmailContent = authEnabled(config)
      ? yield* Effect.try({
          try: () => loadAuthEmailContent(projectRoot, config.auth.email),
          catch: (cause) =>
            new LegacyConfigPushLoadConfigError({
              message: cause instanceof Error ? cause.message : String(cause),
            }),
        })
      : { template: {}, notification: {} };

    // 4. Determine the push target (plain project vs. branch) and, for a
    // branch, gate the push behind an explicit confirmation before any
    // further network call — including the cost matrix below (CLI-2168). A
    // target resolved from an EXPLICIT `--project-ref <name-or-uuid>` this
    // invocation (`resolved.branchResolution`) skips the prompt: the user
    // already expressed same-invocation intent, so re-confirming the exact
    // string they just typed is friction with no safety benefit — the
    // target-echo line below still always prints regardless.
    const target = yield* legacyResolveConfigPushTarget(ref, {
      classifyLookupError: classifyPushProjectLookupError,
      knownBranch: resolved.branchResolution,
    });
    yield* output.raw(legacyConfigPushTargetLines(target), "stderr");
    if (target.kind === "branch" && resolved.branchResolution === undefined) {
      const proceed = yield* legacyPromptYesNo(
        output,
        yes,
        legacyConfigPushBranchPromptLabel(target),
        // Deliberately `false` (unlike this file's other prompts, which
        // default `true`): an unattended run (CI, an agent, a script)
        // without `--yes` must safely decline a branch mutation rather than
        // silently proceed. `--yes`/`SUPABASE_YES` (`yes`, resolved above)
        // is the intended override.
        false,
      );
      if (!proceed) {
        return yield* new LegacyConfigPushCancelledError({ message: CONTEXT_CANCELED_MESSAGE });
      }
    }

    // 5. Cost matrix (drives cost-aware prompts).
    const cost = yield* getCostMatrix(ref);

    // keep(name): the shared confirmation-prompt helper handles all modes,
    // including scanning piped stdin on a non-TTY before falling back to
    // the default.
    const keep = (name: string) =>
      Effect.gen(function* () {
        const item = cost.get(name);
        const title =
          item === undefined
            ? `Do you want to push ${name} config to remote?`
            : `Enabling ${item.name} will cost you ${item.price}. Keep it enabled?`;
        return yield* legacyPromptYesNo(output, yes, title, true);
      });

    const services: Array<LegacyConfigPushServiceResult> = [];

    // 6a. api
    {
      const local = apiSubsetFromConfig(config);
      const remote = yield* api.v1.getPostgrestServiceConfig({ ref }).pipe(
        Effect.catch(
          mapLegacyHttpError({
            networkError: LegacyConfigPushApiReadNetworkError,
            statusError: LegacyConfigPushApiReadStatusError,
            networkMessage: (cause) => `failed to read API config: ${cause}`,
            statusMessage: readStatusMessage,
          }),
        ),
      );
      const d = diffApiWithRemote(local, remote);
      if (d.length === 0) {
        yield* output.raw("Remote API config is up to date.\n", "stderr");
        services.push({ service: "api", status: "up_to_date" });
      } else {
        yield* output.raw(`Updating API service with config: ${d}\n`, "stderr");
        if (yield* keep("api")) {
          yield* api.v1.updatePostgrestServiceConfig({ ref, ...apiToUpdateBody(local) }).pipe(
            Effect.catch(
              mapLegacyHttpError({
                networkError: LegacyConfigPushApiUpdateNetworkError,
                statusError: LegacyConfigPushApiUpdateStatusError,
                networkMessage: (cause) => `failed to update API config: ${cause}`,
                statusMessage: readStatusMessage,
              }),
            ),
          );
          services.push({ service: "api", status: "updated" });
        } else {
          services.push({ service: "api", status: "skipped" });
        }
      }
    }

    // 6b. db.settings (no gate — always processed)
    {
      const local = dbSettingsFromConfig(config);
      const response = yield* api.v1.getPostgresConfig({ ref }).pipe(
        Effect.catch(
          mapLegacyHttpError({
            networkError: LegacyConfigPushDbReadNetworkError,
            statusError: LegacyConfigPushDbReadStatusError,
            networkMessage: (cause) => `failed to read DB config: ${cause}`,
            statusMessage: readStatusMessage,
          }),
        ),
      );
      const remote: Readonly<Record<string, string | number | boolean | undefined>> = {
        ...response,
      };
      const d = diffDbSettingsWithRemote(local, remote);
      if (d.length === 0) {
        yield* output.raw("Remote DB config is up to date.\n", "stderr");
        services.push({ service: "db.settings", status: "up_to_date" });
      } else {
        yield* output.raw(`Updating DB service with config: ${d}\n`, "stderr");
        if (yield* keep("db")) {
          yield* api.v1.updatePostgresConfig({ ref, ...dbSettingsToUpdateBody(local) }).pipe(
            Effect.catch(
              mapLegacyHttpError({
                networkError: LegacyConfigPushDbUpdateNetworkError,
                statusError: LegacyConfigPushDbUpdateStatusError,
                networkMessage: (cause) => `failed to update DB config: ${cause}`,
                statusMessage: readStatusMessage,
              }),
            ),
          );
          services.push({ service: "db.settings", status: "updated" });
        } else {
          services.push({ service: "db.settings", status: "skipped" });
        }
      }
    }

    // 6c. db.network_restrictions (gated on local enabled)
    {
      const local = networkRestrictionsFromConfig(config);
      if (!local.enabled) {
        services.push({ service: "db.network_restrictions", status: "disabled" });
      } else {
        const remote = yield* api.v1.getNetworkRestrictions({ ref }).pipe(
          Effect.catch(
            mapLegacyHttpError({
              networkError: LegacyConfigPushNetworkRestrictionsReadNetworkError,
              statusError: LegacyConfigPushNetworkRestrictionsReadStatusError,
              networkMessage: (cause) => `failed to read network restrictions config: ${cause}`,
              statusMessage: readStatusMessage,
            }),
          ),
        );
        const d = diffNetworkRestrictionsWithRemote(local, remote);
        if (d.length === 0) {
          yield* output.raw("Remote DB Network restrictions config is up to date.\n", "stderr");
          services.push({ service: "db.network_restrictions", status: "up_to_date" });
        } else {
          yield* output.raw(`Updating network restrictions with config: ${d}\n`, "stderr");
          if (yield* keep("db")) {
            yield* api.v1
              .updateNetworkRestrictions({ ref, ...networkRestrictionsToUpdateBody(local) })
              .pipe(
                Effect.catch(
                  mapLegacyHttpError({
                    networkError: LegacyConfigPushNetworkRestrictionsUpdateNetworkError,
                    statusError: LegacyConfigPushNetworkRestrictionsUpdateStatusError,
                    networkMessage: (cause) =>
                      `failed to update network restrictions config: ${cause}`,
                    statusMessage: readStatusMessage,
                  }),
                ),
              );
            services.push({ service: "db.network_restrictions", status: "updated" });
          } else {
            services.push({ service: "db.network_restrictions", status: "skipped" });
          }
        }
      }
    }

    // 6d. db.ssl_enforcement (only when locally configured)
    {
      const local = sslEnforcementFromConfig(config, presence.sslEnforcement);
      if (local === undefined) {
        services.push({ service: "db.ssl_enforcement", status: "disabled" });
      } else {
        const remote = yield* api.v1.getSslEnforcementConfig({ ref }).pipe(
          Effect.catch(
            mapLegacyHttpError({
              networkError: LegacyConfigPushSslEnforcementReadNetworkError,
              statusError: LegacyConfigPushSslEnforcementReadStatusError,
              networkMessage: (cause) => `failed to read SSL enforcement config: ${cause}`,
              statusMessage: readStatusMessage,
            }),
          ),
        );
        const d = diffSslEnforcementWithRemote(local, remote);
        if (d.length === 0) {
          yield* output.raw("Remote DB SSL enforcement config is up to date.\n", "stderr");
          services.push({ service: "db.ssl_enforcement", status: "up_to_date" });
        } else {
          yield* output.raw(`Updating SSL enforcement with config: ${d}\n`, "stderr");
          if (yield* keep("db")) {
            yield* api.v1
              .updateSslEnforcementConfig({ ref, ...sslEnforcementToUpdateBody(local) })
              .pipe(
                Effect.catch(
                  mapLegacyHttpError({
                    networkError: LegacyConfigPushSslEnforcementUpdateNetworkError,
                    statusError: LegacyConfigPushSslEnforcementUpdateStatusError,
                    networkMessage: (cause) => `failed to update SSL enforcement config: ${cause}`,
                    statusMessage: readStatusMessage,
                  }),
                ),
              );
            services.push({ service: "db.ssl_enforcement", status: "updated" });
          } else {
            services.push({ service: "db.ssl_enforcement", status: "skipped" });
          }
        }
      }
    }

    // 6e. auth (gated on local enabled; MFA addon cost filter)
    {
      if (!authEnabled(config)) {
        services.push({ service: "auth", status: "disabled" });
      } else {
        const remote = yield* api.v1.getAuthServiceConfig({ ref }).pipe(
          Effect.catch(
            mapLegacyHttpError({
              networkError: LegacyConfigPushAuthReadNetworkError,
              statusError: LegacyConfigPushAuthReadStatusError,
              networkMessage: (cause) => `failed to read Auth config: ${cause}`,
              statusMessage: readStatusMessage,
            }),
          ),
        );
        // `dotenvPrivateKeys` decrypts any `encrypted:` auth secret before it's
        // hashed/copied into the update body. The document-wide check above
        // (step 3b) already scanned every `config.Secret` path — including every
        // field `authSubsetFromConfig` reads — and would have aborted by now if
        // any were undecryptable, so the decrypt calls inside it are unreachable
        // failure paths here, not a real branch to guard with `Effect.try`.
        let local = authSubsetFromConfig(
          config,
          projectId,
          presence.auth,
          authEmailContent,
          dotenvPrivateKeys,
        );
        const projected = applyRemoteAuthConfig(local, remote);
        // MFA phone/webauthn are paid addons: confirm cost before enabling.
        if (mfaPhoneNewlyEnabled(local, projected) && !(yield* keep("auth_mfa_phone"))) {
          local = disableMfaPhone(local);
        }
        if (mfaWebauthnNewlyEnabled(local, projected) && !(yield* keep("auth_mfa_web_authn"))) {
          local = disableMfaWebauthn(local);
        }
        const d = diffAuth(projected, local);
        if (d.length === 0) {
          yield* output.raw("Remote Auth config is up to date.\n", "stderr");
          services.push({ service: "auth", status: "up_to_date" });
        } else {
          yield* output.raw(`Updating Auth service with config: ${d}\n`, "stderr");
          if (yield* keep("auth")) {
            yield* api.v1.updateAuthServiceConfig({ ref, ...authToUpdateBody(local) }).pipe(
              Effect.catch(
                mapLegacyHttpError({
                  networkError: LegacyConfigPushAuthUpdateNetworkError,
                  statusError: LegacyConfigPushAuthUpdateStatusError,
                  networkMessage: (cause) => `failed to update Auth config: ${cause}`,
                  statusMessage: readStatusMessage,
                }),
              ),
            );
            services.push({ service: "auth", status: "updated" });
          } else {
            services.push({ service: "auth", status: "skipped" });
          }
        }
      }
    }

    // 6f. storage (gated on local enabled)
    {
      const local = storageSubsetFromConfig(config, {
        imageTransformation: presence.imageTransformation,
        s3Protocol: presence.s3Protocol,
      });
      if (!local.enabled) {
        services.push({ service: "storage", status: "disabled" });
      } else {
        const remote = yield* api.v1.getStorageConfig({ ref }).pipe(
          Effect.catch(
            mapLegacyHttpError({
              networkError: LegacyConfigPushStorageReadNetworkError,
              statusError: LegacyConfigPushStorageReadStatusError,
              networkMessage: (cause) => `failed to read Storage config: ${cause}`,
              statusMessage: readStatusMessage,
            }),
          ),
        );
        const d = diffStorageWithRemote(local, remote);
        if (d.length === 0) {
          yield* output.raw("Remote Storage config is up to date.\n", "stderr");
          services.push({ service: "storage", status: "up_to_date" });
        } else {
          yield* output.raw(`Updating Storage service with config: ${d}\n`, "stderr");
          if (yield* keep("storage")) {
            yield* api.v1.updateStorageConfig({ ref, ...storageToUpdateBody(local) }).pipe(
              Effect.catch(
                mapLegacyHttpError({
                  networkError: LegacyConfigPushStorageUpdateNetworkError,
                  statusError: LegacyConfigPushStorageUpdateStatusError,
                  networkMessage: (cause) => `failed to update Storage config: ${cause}`,
                  statusMessage: readStatusMessage,
                }),
              ),
            );
            services.push({ service: "storage", status: "updated" });
          } else {
            services.push({ service: "storage", status: "skipped" });
          }
        }
      }
    }

    // 6g. experimental.webhooks (no GET / diff)
    {
      if (!experimentalWebhooksEnabled(config)) {
        services.push({ service: "experimental.webhooks", status: "disabled" });
      } else {
        yield* output.raw(`Enabling webhooks for project: ${ref}\n`, "stderr");
        if (yield* keep("webhooks")) {
          yield* api.v1.enableDatabaseWebhook({ ref }).pipe(
            Effect.catch(
              mapLegacyHttpError({
                networkError: LegacyConfigPushEnableWebhookNetworkError,
                statusError: LegacyConfigPushEnableWebhookStatusError,
                networkMessage: (cause) => `failed to enable webhooks: ${cause}`,
                statusMessage: (status, body) =>
                  `unexpected enable webhook status ${status}: ${body}`,
              }),
            ),
          );
          services.push({ service: "experimental.webhooks", status: "updated" });
        } else {
          services.push({ service: "experimental.webhooks", status: "skipped" });
        }
      }
    }

    // 7. Machine-readable summary (Go has none; text mode emits nothing extra).
    if (output.format !== "text") {
      yield* output.success("", {
        project_ref: projectId,
        ...legacyConfigPushPayloadFields(target),
        services,
      });
    }
  }).pipe(
    Effect.ensuring(
      Effect.suspend(() =>
        resolvedRef === undefined ? Effect.void : linkedProjectCache.cache(resolvedRef),
      ),
    ),
    Effect.ensuring(telemetryState.flush),
  );
});
