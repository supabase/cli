import { dirname } from "node:path";
import { fromApiProjectConfig, fromConfigDocument } from "@supabase/config";
import { diffProjectConfig, loadCliConfig, type ConfigChange } from "@supabase/config/internal";
import { findCliProjectRoot } from "@supabase/config/effect";
import { operationDefinitions } from "@supabase/api/effect";
import { Clock, Effect, FileSystem, Path } from "effect";

import { LegacyPlatformApi } from "../../../auth/legacy-platform-api.service.ts";
import { LegacyCliSettings } from "../../../config/legacy-cli-settings.service.ts";
import { LegacyProjectRefResolver } from "../../../config/legacy-project-ref.service.ts";
import { LegacyLinkedProjectCache } from "../../../telemetry/legacy-linked-project-cache.service.ts";
import { LegacyTelemetryState } from "../../../telemetry/legacy-telemetry-state.service.ts";
import { legacyResolveYesWithProjectEnv } from "../../../../shared/legacy/global-flags.ts";
import { Output } from "../../../../shared/output/output.service.ts";
import { Stdin } from "../../../../shared/runtime/stdin.service.ts";
import { Tty } from "../../../../shared/runtime/tty.service.ts";
import {
  legacyAssertDecryptableSecrets,
  legacyLoadProjectEnv,
} from "../../../shared/legacy-db-config.toml-read.ts";
import {
  legacySanitizeInlineName,
  mapLegacyHttpError,
  sanitizeLegacyErrorBody,
} from "../../../shared/legacy-http-errors.ts";
import { legacyPromptYesNo } from "../../../../shared/legacy/legacy-prompt-yes-no.ts";
import { legacyCollectDotenvPrivateKeys } from "../../../shared/legacy-vault-decrypt.ts";
import { legacyConfigApiScope, legacyConfigScopeLine } from "../config.format.ts";
import { legacyConfigProjectConfigTry } from "../config.project-config.ts";
import {
  legacyConfigReadStatusMessage,
  legacyUnexpectedStatusMessage,
} from "../config.read-status.ts";
import { legacyLoadAuthEmailContent } from "./push.auth-email-content.ts";
import { getCostMatrix } from "./push.cost-matrix.ts";
import {
  legacyEncodeApiBody,
  legacyEncodeAuthBody,
  legacyEncodeDbSettingsBody,
  legacyEncodeNetworkRestrictionsBody,
  legacyEncodeSslEnforcementBody,
  legacyEncodeStorageBody,
  type LegacyPushEncoded,
} from "./push.encoders.ts";
import {
  LegacyConfigPushApiUpdateNetworkError,
  LegacyConfigPushApiUpdateStatusError,
  LegacyConfigPushAuthUpdateNetworkError,
  LegacyConfigPushAuthUpdateStatusError,
  LegacyConfigPushConfigEmptyError,
  LegacyConfigPushConfigReadNetworkError,
  LegacyConfigPushConfigReadStatusError,
  LegacyConfigPushDbUpdateNetworkError,
  LegacyConfigPushDbUpdateStatusError,
  LegacyConfigPushEnableWebhookNetworkError,
  LegacyConfigPushEnableWebhookStatusError,
  LegacyConfigPushLoadConfigError,
  LegacyConfigPushNetworkRestrictionsUpdateNetworkError,
  LegacyConfigPushNetworkRestrictionsUpdateStatusError,
  LegacyConfigPushSslEnforcementUpdateNetworkError,
  LegacyConfigPushSslEnforcementUpdateStatusError,
  LegacyConfigPushStorageUpdateNetworkError,
  LegacyConfigPushStorageUpdateStatusError,
} from "./push.errors.ts";
import {
  legacyPushNotes,
  legacyPushNotPushableLine,
  legacyPushPayload,
  legacyPushSummaryMessage,
  legacyPushUpdatingLine,
  legacyPushUpToDateLine,
  type LegacyPushForced,
  type LegacyPushUnencodable,
} from "./push.format.ts";
import { legacyComparePaths, legacyIsRecord, legacySamePath } from "./push.paths.ts";
import {
  LEGACY_PUSH_ADDON_GATES,
  LEGACY_PUSH_RESOURCES,
  legacyApplyMfaAddonDecline,
  legacyChangesCommunicated,
  legacyPlanConfigPush,
  legacyPushPromptKey,
  legacyPushResourceEnabled,
  legacyPushResourceForPath,
  legacyPushResponseBlock,
  type LegacyPushResource,
} from "./push.plan.ts";
import { legacyResolveAuthSecrets, type LegacyPushSecretDecision } from "./push.secrets.ts";
import type { LegacyConfigPushFlags } from "./push.command.ts";
import type { LegacyConfigPushServiceResult } from "./push.types.ts";

/** The `services[].changes` union (D8): encoded paths ∪ content extras ∪ secret paths the write
 * ACTUALLY sent, path-sorted. `sentSecretPaths` is `[]` for a declined/skipped write. */
function legacyPushServiceChanges(
  encoded: LegacyPushEncoded<unknown>,
  sentSecretPaths: ReadonlyArray<ReadonlyArray<string>>,
): ReadonlyArray<ReadonlyArray<string>> {
  return [...encoded.encoded, ...encoded.extras.map((extra) => extra.path), ...sentSecretPaths]
    .slice()
    .sort(legacyComparePaths);
}

/** `push.format.ts` must never see a secret's plaintext. */
function toSecretReport(decision: LegacyPushSecretDecision) {
  const { plaintext: _plaintext, ...report } = decision;
  return report;
}

export const legacyConfigPush = Effect.fn("legacy.config.push")(function* (
  flags: LegacyConfigPushFlags,
) {
  const output = yield* Output;
  const api = yield* LegacyPlatformApi;
  const resolver = yield* LegacyProjectRefResolver;
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

  const ref = yield* resolver.resolve(flags.projectRef);

  yield* Effect.gen(function* () {
    // 1. Load config.toml (TOML parse error aborts before any network call).
    //
    // NOTE (CLI-1489): `config push` needs the fully decoded config (every
    // service subset), so it uses `loadCliConfig` rather than the tolerant
    // `legacy-db-config.toml-read.ts` subtree reader. `loadCliConfig` raises
    // `CliConfigParseError` on `env(...)` refs over numeric/bool fields.
    // Pass `ref` so a matching `[remotes.*]` block is merged over the base
    // config before decode. A duplicate `project_id` across remotes surfaces
    // an established error message.
    const loaded = yield* loadCliConfig(cliSettings.workdir, {
      projectRef: ref,
      goViperCompat: true,
    }).pipe(
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
    );
    if (loaded === null) {
      return yield* new LegacyConfigPushLoadConfigError({
        message: "failed to read supabase/config.toml: file not found",
      });
    }
    // Printed from inside config load, before any command output.
    if (loaded.appliedRemote !== undefined) {
      yield* output.raw(
        `Loading config override: [remotes.${legacySanitizeInlineName(loaded.appliedRemote)}]\n`,
        "stderr",
      );
    }
    const config = loaded.config;

    // 1b. Assert every `config.Secret`-typed `encrypted:` value in the
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
    // path list rather than a second scanner. `loadCliConfig` always
    // populates this field with a (possibly empty) record — never
    // `undefined` — so no fallback is needed here.
    const secretError =
      legacyAssertDecryptableSecrets(loaded.document, secretEnvLookup, dotenvPrivateKeys) ??
      legacyAssertDecryptableSecrets(
        { auth: { external: loaded.removedDeprecatedExternalProviders } },
        secretEnvLookup,
        dotenvPrivateKeys,
      );
    if (secretError !== undefined) {
      return yield* new LegacyConfigPushLoadConfigError({ message: secretError });
    }

    // Config lives at <projectRoot>/supabase/config.{toml,json}.
    const configProjectRoot = dirname(dirname(loaded.path));

    // Email content validation runs during config load, before any network call.
    const authEmailContent = config.auth.enabled
      ? yield* Effect.try({
          try: () => legacyLoadAuthEmailContent(configProjectRoot, config.auth.email),
          catch: (cause) =>
            new LegacyConfigPushLoadConfigError({
              message: cause instanceof Error ? cause.message : String(cause),
            }),
        })
      : { template: {}, notification: {} };

    // 2. Cost matrix (drives cost-aware prompts) — still fetched before the
    // effective-config read below.
    const cost = yield* getCostMatrix(ref);

    yield* output.raw(`Pushing config to project: ${legacySanitizeInlineName(ref)}\n`, "stderr");

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

    // 3. Read the project's effective configuration once — replaces the
    // former five per-service `GET /v1/...` calls. No spinner (matches the
    // rest of this command's stderr progress lines).
    const response = yield* api.executeRaw(operationDefinitions.v2GetProjectConfig, { ref }).pipe(
      Effect.mapError(
        (cause) =>
          new LegacyConfigPushConfigReadNetworkError({
            message: `failed to read project config: ${cause}`,
          }),
      ),
    );
    if (response.status !== 200) {
      const body = sanitizeLegacyErrorBody(
        yield* response.text.pipe(Effect.orElseSucceed(() => "")),
      );
      return yield* new LegacyConfigPushConfigReadStatusError({
        status: response.status,
        body,
        message: legacyConfigReadStatusMessage(response.status, body, ref),
      });
    }
    const responseJson = yield* response.json.pipe(
      Effect.mapError(
        (cause) =>
          new LegacyConfigPushConfigReadNetworkError({
            message: `failed to read project config: ${cause}`,
            decode: true,
          }),
      ),
    );
    // A 200 response whose body isn't even a JSON object is an API-response
    // problem, not something `fromApiProjectConfig` should have to reject
    // via its own typed error — checked once, up front, so every read below
    // can index `responseJson` directly.
    if (!legacyIsRecord(responseJson)) {
      return yield* new LegacyConfigPushConfigReadNetworkError({
        message: "failed to read project config: response body is not a JSON object",
        decode: true,
      });
    }

    // 4. Convert the response and classify against the local projection.
    // A response the registry cannot narrow, or a local document it cannot
    // canonicalize, is a typed `ProjectConfigParseError`; anything else is a
    // defect (`legacyConfigProjectConfigTry`, shared with `config
    // diff`/`config pull`).
    const remote = yield* legacyConfigProjectConfigTry(() => fromApiProjectConfig(responseJson));

    const data = responseJson["data"];
    const attributes =
      legacyIsRecord(data) && legacyIsRecord(data["attributes"]) ? data["attributes"] : {};
    const scope = legacyConfigApiScope(attributes);
    // Always echoed (family consistency with `config diff`/`config pull`),
    // not just when a block is missing.
    yield* output.raw(legacyConfigScopeLine(scope), "stderr");
    if (scope.present.length === 0) {
      return yield* new LegacyConfigPushConfigEmptyError({
        message: `The API returned no configuration for project ${legacySanitizeInlineName(ref)}; nothing was pushed. Check that your access token can read the project's configuration.`,
      });
    }
    const remoteAuthAttributes = legacyIsRecord(attributes["auth"]) ? attributes["auth"] : {};

    const local = yield* legacyConfigProjectConfigTry(() => fromConfigDocument(loaded));
    const changeSet = yield* legacyConfigProjectConfigTry(() =>
      diffProjectConfig({ local: loaded, remote }),
    );

    // 5. Route pushable changes to their v1 write endpoint and resolve every
    // declared secret's send/unchanged/not_set/gated status.
    const plan = legacyPlanConfigPush(changeSet);
    // Defensive: the document-wide decrypt-or-abort pre-check above (step 1b)
    // is expected to make this unreachable — kept as a typed failure, in the
    // same `failed to parse config: <cause>` shape, rather than an uncaught
    // throw, in case that invariant is ever violated (see push.secret.ts).
    const secrets = yield* Effect.try({
      try: () =>
        legacyResolveAuthSecrets({
          maskedPaths: changeSet.masked,
          config,
          local,
          remoteAuthAttributes,
          projectRef: ref,
          dotenvPrivateKeys,
        }),
      catch: (cause) =>
        new LegacyConfigPushLoadConfigError({
          message: cause instanceof Error ? cause.message : String(cause),
        }),
    });
    const now = new Date(yield* Clock.currentTimeMillis);

    // Whether each resource's local gate is on — computed once, both for the
    // resource loop below and for excluding a gated-off resource's own
    // `unmanaged` entries from the summary note (D5).
    const resourceEnabled: Readonly<Record<LegacyPushResource, boolean>> = {
      api: legacyPushResourceEnabled("api", config, local),
      "db.settings": legacyPushResourceEnabled("db.settings", config, local),
      "db.network_restrictions": legacyPushResourceEnabled(
        "db.network_restrictions",
        config,
        local,
      ),
      "db.ssl_enforcement": legacyPushResourceEnabled("db.ssl_enforcement", config, local),
      auth: legacyPushResourceEnabled("auth", config, local),
      storage: legacyPushResourceEnabled("storage", config, local),
    };

    const services: Array<LegacyConfigPushServiceResult> = [];
    const unsupported: Array<ReadonlyArray<string>> = [...plan.unsupported];
    const unencodable: Array<LegacyPushUnencodable> = [];
    const forced: Array<LegacyPushForced> = [];
    const declinedAddons: Array<string> = [];
    let authWriteRan = false;

    // 6. Prints the resource's `Updating ... with config:` block (or the
    // up-to-date/not-pushable line), prompts, writes, and returns the
    // service's result. `secretsForResource` is the resource's full
    // (unfiltered) secret-decision list — `legacyPushUpdatingLine` renders
    // only `send`/`not_set` entries, so non-auth resources simply pass `[]`.
    function applyResource<Body, E, R>(
      resource: LegacyPushResource,
      changes: ReadonlyArray<ConfigChange>,
      encoded: LegacyPushEncoded<Body>,
      secretsForResource: ReadonlyArray<LegacyPushSecretDecision>,
      write: (body: Body) => Effect.Effect<unknown, E, R>,
    ): Effect.Effect<LegacyConfigPushServiceResult, E, R | Tty | Stdin> {
      return Effect.gen(function* () {
        if (encoded.body === undefined) {
          if (encoded.unencodable.length > 0) {
            yield* output.raw(
              legacyPushNotPushableLine(resource, encoded.unencodable.length),
              "stderr",
            );
            return { service: resource, status: "not_pushable", changes: [] };
          }
          yield* output.raw(legacyPushUpToDateLine(resource), "stderr");
          return { service: resource, status: "up_to_date", changes: [] };
        }
        const body = encoded.body;
        const communicated = legacyChangesCommunicated(changes, encoded.encoded);
        yield* output.raw(
          legacyPushUpdatingLine({
            resource,
            changes: communicated,
            secrets: secretsForResource.map(toSecretReport),
            extras: encoded.extras,
            forced: encoded.forced,
          }),
          "stderr",
        );
        if (yield* keep(legacyPushPromptKey(resource))) {
          yield* write(body);
          const sentSecretPaths = secretsForResource
            .filter((secret) => secret.status === "send")
            .map((secret) => secret.path);
          return {
            service: resource,
            status: "updated",
            changes: legacyPushServiceChanges(encoded, sentSecretPaths),
          };
        }
        return {
          service: resource,
          status: "skipped",
          changes: legacyPushServiceChanges(encoded, []),
        };
      });
    }

    // 7. Six resources, in the established push order. A resource whose
    // response block was omitted from the read is `unavailable` — nothing is
    // compared, nothing is written (S5/D2); the `Comparison scope:` line
    // above already explains why. Otherwise, a gated-off resource is simply
    // `disabled` — the projection's disabled-sentinel prune already removed
    // its other declared keys before diffing, so `plan.changesByResource`
    // never has anything left to route here — and a gated-on resource
    // dispatches to its own encoder/write pair.
    for (const resource of LEGACY_PUSH_RESOURCES) {
      if (scope.missing.includes(legacyPushResponseBlock(resource))) {
        services.push({ service: resource, status: "unavailable", changes: [] });
        continue;
      }
      if (!resourceEnabled[resource]) {
        services.push({ service: resource, status: "disabled", changes: [] });
        continue;
      }

      switch (resource) {
        case "api": {
          const changes = plan.changesByResource.api;
          const encoded = legacyEncodeApiBody({ changes, local, remote });
          const result = yield* applyResource("api", changes, encoded, [], (body) =>
            api.v1.updatePostgrestServiceConfig({ ref, ...body }).pipe(
              Effect.catch(
                mapLegacyHttpError({
                  networkError: LegacyConfigPushApiUpdateNetworkError,
                  statusError: LegacyConfigPushApiUpdateStatusError,
                  networkMessage: (cause) => `failed to update API config: ${cause}`,
                  statusMessage: legacyUnexpectedStatusMessage,
                }),
              ),
            ),
          );
          services.push(result);
          unencodable.push(...encoded.unencodable);
          if (result.status === "updated") forced.push(...encoded.forced);
          break;
        }
        case "db.settings": {
          const changes = plan.changesByResource["db.settings"];
          const encoded = legacyEncodeDbSettingsBody({ changes, local, remote });
          const result = yield* applyResource("db.settings", changes, encoded, [], (body) =>
            api.v1.updatePostgresConfig({ ref, ...body }).pipe(
              Effect.catch(
                mapLegacyHttpError({
                  networkError: LegacyConfigPushDbUpdateNetworkError,
                  statusError: LegacyConfigPushDbUpdateStatusError,
                  networkMessage: (cause) => `failed to update DB config: ${cause}`,
                  statusMessage: legacyUnexpectedStatusMessage,
                }),
              ),
            ),
          );
          services.push(result);
          unencodable.push(...encoded.unencodable);
          if (result.status === "updated") forced.push(...encoded.forced);
          break;
        }
        case "db.network_restrictions": {
          const changes = plan.changesByResource["db.network_restrictions"];
          const encoded = legacyEncodeNetworkRestrictionsBody({ changes, local, remote });
          const result = yield* applyResource(
            "db.network_restrictions",
            changes,
            encoded,
            [],
            (body) =>
              api.v1.updateNetworkRestrictions({ ref, ...body }).pipe(
                Effect.catch(
                  mapLegacyHttpError({
                    networkError: LegacyConfigPushNetworkRestrictionsUpdateNetworkError,
                    statusError: LegacyConfigPushNetworkRestrictionsUpdateStatusError,
                    networkMessage: (cause) =>
                      `failed to update network restrictions config: ${cause}`,
                    statusMessage: legacyUnexpectedStatusMessage,
                  }),
                ),
              ),
          );
          services.push(result);
          unencodable.push(...encoded.unencodable);
          if (result.status === "updated") forced.push(...encoded.forced);
          break;
        }
        case "db.ssl_enforcement": {
          const changes = plan.changesByResource["db.ssl_enforcement"];
          const encoded = legacyEncodeSslEnforcementBody({ changes, local, remote });
          const result = yield* applyResource("db.ssl_enforcement", changes, encoded, [], (body) =>
            api.v1.updateSslEnforcementConfig({ ref, ...body }).pipe(
              Effect.catch(
                mapLegacyHttpError({
                  networkError: LegacyConfigPushSslEnforcementUpdateNetworkError,
                  statusError: LegacyConfigPushSslEnforcementUpdateStatusError,
                  networkMessage: (cause) => `failed to update SSL enforcement config: ${cause}`,
                  statusMessage: legacyUnexpectedStatusMessage,
                }),
              ),
            ),
          );
          services.push(result);
          unencodable.push(...encoded.unencodable);
          if (result.status === "updated") forced.push(...encoded.forced);
          break;
        }
        case "auth": {
          // MFA addon cost filter runs before anything about auth is
          // printed: a declined paid addon carries an explicit disable when
          // the remote currently has it on, or is simply dropped otherwise
          // (`legacyApplyMfaAddonDecline`, D12).
          let changes = plan.changesByResource.auth;
          for (const gate of LEGACY_PUSH_ADDON_GATES) {
            const verifyChange = changes.find((change) =>
              legacySamePath(change.path, gate.verifyPath),
            );
            if (verifyChange?.local === true && !(yield* keep(gate.costKey))) {
              changes = legacyApplyMfaAddonDecline(changes, gate, remote);
              declinedAddons.push(gate.costKey);
            }
          }

          const encoded = legacyEncodeAuthBody({
            changes,
            local,
            remote,
            secrets,
            emailContent: authEmailContent,
            remoteAuthAttributes,
            now,
          });
          const result = yield* applyResource("auth", changes, encoded, secrets, (body) =>
            api.v1.updateAuthServiceConfig({ ref, ...body }).pipe(
              Effect.catch(
                mapLegacyHttpError({
                  networkError: LegacyConfigPushAuthUpdateNetworkError,
                  statusError: LegacyConfigPushAuthUpdateStatusError,
                  networkMessage: (cause) => `failed to update Auth config: ${cause}`,
                  statusMessage: legacyUnexpectedStatusMessage,
                }),
              ),
            ),
          );
          services.push(result);
          unencodable.push(...encoded.unencodable);
          authWriteRan = result.status === "updated";
          if (result.status === "updated") forced.push(...encoded.forced);
          break;
        }
        case "storage": {
          const changes = plan.changesByResource.storage;
          const encoded = legacyEncodeStorageBody({ changes, local, remote, config });
          const result = yield* applyResource("storage", changes, encoded, [], (body) =>
            api.v1.updateStorageConfig({ ref, ...body }).pipe(
              Effect.catch(
                mapLegacyHttpError({
                  networkError: LegacyConfigPushStorageUpdateNetworkError,
                  statusError: LegacyConfigPushStorageUpdateStatusError,
                  networkMessage: (cause) => `failed to update Storage config: ${cause}`,
                  statusMessage: legacyUnexpectedStatusMessage,
                }),
              ),
            ),
          );
          services.push(result);
          unencodable.push(...encoded.unencodable);
          if (result.status === "updated") forced.push(...encoded.forced);
          break;
        }
      }
    }

    // 7g. experimental.webhooks (no read/diff — a fixed enable-only POST).
    if (config.experimental?.webhooks?.enabled !== true) {
      services.push({ service: "experimental.webhooks", status: "disabled", changes: [] });
    } else {
      yield* output.raw(
        `Enabling webhooks for project: ${legacySanitizeInlineName(ref)}\n`,
        "stderr",
      );
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
        services.push({ service: "experimental.webhooks", status: "updated", changes: [] });
      } else {
        services.push({ service: "experimental.webhooks", status: "skipped", changes: [] });
      }
    }

    // 8. Notes (stderr, after the resource loop) — declared properties with
    // no API field, declared-but-unencodable properties, declared-but-
    // unmanaged properties (count only, excluding a gated-off resource's own
    // entries), forced companion defaults, empty/unresolved credentials, and
    // the hands-off remote-only count.
    const unmanagedCount = changeSet.unmanaged.filter((changePath) => {
      const resourceForPath = legacyPushResourceForPath(changePath);
      return resourceForPath === "unsupported" || resourceEnabled[resourceForPath];
    }).length;
    // An `unavailable` auth resource never read (or wrote) any credential —
    // the "not pushed" framing this note carries is specific to a credential
    // whose OWN value was empty/unresolved, which doesn't apply when the
    // whole resource was never compared to begin with.
    const authUnavailable =
      services.find((service) => service.service === "auth")?.status === "unavailable";
    const notes = legacyPushNotes({
      unsupported,
      unencodable,
      unmanagedCount,
      forced,
      secretsNotSet: authUnavailable
        ? []
        : secrets.filter((secret) => secret.status === "not_set").map((secret) => secret.path),
      remoteOnly: plan.remoteOnly,
    });
    if (notes !== "") {
      yield* output.raw(notes, "stderr");
    }

    // 9. Machine-readable summary in `json` / `stream-json` mode.
    if (output.format !== "text") {
      const payloadInput = {
        projectRef: ref,
        services,
        unsupported,
        unencodable,
        forced,
        unmanaged: changeSet.unmanaged,
        unmanagedCount,
        secrets: secrets.map(toSecretReport),
        authWriteRan,
        declinedAddons,
        remoteOnly: plan.remoteOnly,
        scope,
      };
      yield* output.success(
        legacyPushSummaryMessage(payloadInput),
        legacyPushPayload(payloadInput),
      );
    }
  }).pipe(Effect.ensuring(linkedProjectCache.cache(ref)), Effect.ensuring(telemetryState.flush));
});
