import { loadProjectConfig } from "@supabase/config";
import { Effect } from "effect";

import { LegacyPlatformApi } from "../../../auth/legacy-platform-api.service.ts";
import { LegacyProjectRefResolver } from "../../../config/legacy-project-ref.service.ts";
import { LegacyLinkedProjectCache } from "../../../telemetry/legacy-linked-project-cache.service.ts";
import { LegacyTelemetryState } from "../../../telemetry/legacy-telemetry-state.service.ts";
import { legacyResolveYes } from "../../../../shared/legacy/global-flags.ts";
import { Output } from "../../../../shared/output/output.service.ts";
import { RuntimeInfo } from "../../../../shared/runtime/runtime-info.service.ts";
import { mapLegacyHttpError } from "../../../shared/legacy-http-errors.ts";
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
import {
  loadAuthEmailContent,
  projectDirsFromConfigPath,
} from "./config-sync/config-sync.auth-email-content.ts";
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

export const legacyConfigPush = Effect.fn("legacy.config.push")(function* (
  flags: LegacyConfigPushFlags,
) {
  const output = yield* Output;
  const api = yield* LegacyPlatformApi;
  const resolver = yield* LegacyProjectRefResolver;
  const linkedProjectCache = yield* LegacyLinkedProjectCache;
  const telemetryState = yield* LegacyTelemetryState;
  const runtimeInfo = yield* RuntimeInfo;
  // `--yes` OR `SUPABASE_YES` (Go's viper AutomaticEnv, root.go:318-320).
  const yes = yield* legacyResolveYes;

  const ref = yield* resolver.resolve(flags.projectRef);

  yield* Effect.gen(function* () {
    // 1. Load config.toml (TOML parse error aborts before any network call).
    //
    // NOTE (CLI-1489): `config push` needs the fully decoded config (every
    // service subset), so it uses `loadProjectConfig` rather than the tolerant
    // `LegacyProjectConfig` subtree reader. `loadProjectConfig` raises
    // `ProjectConfigParseError` on `env(...)` refs over numeric/bool fields,
    // which Go resolves transparently. Switch to the fixed decoder once
    // CLI-1489 lands; until then this is the conscious tradeoff for this command.
    // Pass `ref` so a matching `[remotes.*]` block is merged over the base config
    // before decode (Go's `loadFromFile` with `Config.ProjectId` set). A duplicate
    // `project_id` across remotes surfaces Go's verbatim message.
    const loaded = yield* loadProjectConfig(runtimeInfo.cwd, { projectRef: ref }).pipe(
      Effect.catchTag(
        "ProjectConfigParseError",
        (cause) =>
          new LegacyConfigPushLoadConfigError({
            message: `failed to parse supabase/config.toml: ${String(cause.cause)}`,
          }),
      ),
      Effect.catchTag(
        "DuplicateRemoteProjectIdError",
        (cause) => new LegacyConfigPushLoadConfigError({ message: cause.message }),
      ),
    );
    if (loaded === null) {
      return yield* new LegacyConfigPushLoadConfigError({
        message: "failed to read supabase/config.toml: file not found",
      });
    }
    // Go prints this from inside config load, before any command output.
    if (loaded.appliedRemote !== undefined) {
      yield* output.raw(`Loading config override: [remotes.${loaded.appliedRemote}]\n`, "stderr");
    }
    const projectId = ref;
    const config = loaded.config;

    // Optional `*pointer` sections (ssl_enforcement, image_transformation,
    // s3_protocol) are defaulted-present by @supabase/config and cannot be
    // recovered from the decoded config, so we inspect the raw (merged) document
    // to restore Go's nil-pointer skip semantics — including sections a matching
    // `[remotes.*]` block introduces.
    const presence = legacyPresenceIn(loaded.document);

    const { projectRoot, supabaseDir } = projectDirsFromConfigPath(loaded.path);

    // Go's `email.validate` runs during `LoadConfig` before any network call.
    const authEmailContent = authEnabled(config)
      ? yield* Effect.try({
          try: () => loadAuthEmailContent(projectRoot, supabaseDir, config.auth.email),
          catch: (cause) =>
            new LegacyConfigPushLoadConfigError({
              message: cause instanceof Error ? cause.message : String(cause),
            }),
        })
      : { template: {}, notification: {} };

    // 2. Cost matrix (drives cost-aware prompts).
    const cost = yield* getCostMatrix(ref);

    yield* output.raw(`Pushing config to project: ${projectId}\n`, "stderr");

    // keep(name): Go push.go `keep` + console.PromptYesNo(title, true).
    const keep = (name: string): Effect.Effect<boolean> =>
      Effect.gen(function* () {
        const item = cost.get(name);
        const title =
          item === undefined
            ? `Do you want to push ${name} config to remote?`
            : `Enabling ${item.name} will cost you ${item.price}. Keep it enabled?`;
        if (output.format !== "text") {
          return true;
        }
        if (yes) {
          yield* output.raw(`${title} [Y/n] y\n`, "stderr");
          return true;
        }
        return yield* output
          .promptConfirm(title, { defaultValue: true })
          .pipe(Effect.orElseSucceed(() => true));
      });

    const services: Array<LegacyConfigPushServiceResult> = [];

    // 3a. api
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

    // 3b. db.settings (no gate — always processed)
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

    // 3c. db.network_restrictions (gated on local enabled)
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

    // 3d. db.ssl_enforcement (only when locally configured)
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

    // 3e. auth (gated on local enabled; MFA addon cost filter)
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
        let local = authSubsetFromConfig(config, projectId, presence.auth, authEmailContent);
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

    // 3f. storage (gated on local enabled)
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

    // 3g. experimental.webhooks (no GET / diff)
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

    // 4. Machine-readable summary (Go has none; text mode emits nothing extra).
    if (output.format !== "text") {
      yield* output.success("", { project_ref: projectId, services });
    }
  }).pipe(Effect.ensuring(linkedProjectCache.cache(ref)), Effect.ensuring(telemetryState.flush));
});
