import { fromApiProjectConfig, fromConfigDocument } from "@supabase/config";
import { diffProjectConfig, type ConfigChange } from "@supabase/config/effect";
import { operationDefinitions } from "@supabase/api/effect";
import { DateTime, Effect, FileSystem, Option, Ref } from "effect";

import { CommandPlatformApi } from "../../../auth/command-platform-api.service.ts";
import { envReferenceNames } from "../../../config/cli-config-document.ts";
import { CliConfigValues } from "../../../config/cli-config-values.service.ts";
import { CommandSettings } from "../../../config/command-settings.service.ts";
import { LinkedProjectCache } from "../../../telemetry/linked-project-cache.service.ts";
import { TelemetryState } from "../../../telemetry/telemetry-state.service.ts";
import { requireHostedMutationConsent } from "../../../command-internal/hosted-consent/hosted-consent.ts";
import { withAnnouncedTarget } from "../../../shared/output/command-target.service.ts";
import { Output } from "../../../shared/output/output.service.ts";
import { assertDecryptableSecrets } from "../../../command-internal/db-config.toml-read.ts";
import { BRANCH_UUID_PATTERN } from "../../../command-internal/ref-patterns.ts";
import {
  sanitizeInlineName,
  mapHttpError,
  sanitizeErrorBody,
  unexpectedStatusMessage,
} from "../../../command-internal/http-errors.ts";
import { resolveProjectTarget } from "../../../command-internal/target/resolve-project-target.ts";
import { targetIsBranchAttribute } from "../../../command-internal/target/target-identity.ts";
import {
  missingProjectConfigMessageEffect,
  relativeConfigPath,
  requireExplicitWorkdirProject,
} from "../../../command-internal/workdir-project.ts";
import { validateWorkdirIsDirectory } from "../../../command-internal/workdir-validation.ts";
import { mapConfigLoadError } from "../config.load.ts";
import {
  configApiScope,
  configEnvOriginLookup,
  configProviderDisableWarnings,
  configScopeLine,
  type ConfigEnvOriginLookup,
} from "../config.format.ts";
import { configProjectConfigTry } from "../config.project-config.ts";
import { configReadStatusMessage } from "../config.read-status.ts";
import { loadAuthEmailContent } from "./push.auth-email-content.ts";
import { type ConfigPushKnownBranch, resolveConfigPushTarget } from "./push.branch-target.ts";
import { getCostMatrix } from "./push.cost-matrix.ts";
import {
  encodeApiBody,
  encodeAuthBody,
  encodeDbSettingsBody,
  encodeNetworkRestrictionsBody,
  encodeSslEnforcementBody,
  encodeStorageBody,
  type PushEncoded,
} from "./push.encoders.ts";
import {
  ConfigPushApiUpdateNetworkError,
  ConfigPushApiUpdateStatusError,
  ConfigPushAuthUpdateNetworkError,
  ConfigPushAuthUpdateStatusError,
  ConfigPushConfigEmptyError,
  ConfigPushConfigReadNetworkError,
  ConfigPushConfigReadStatusError,
  ConfigPushDbUpdateNetworkError,
  ConfigPushDbUpdateStatusError,
  ConfigPushEnableWebhookNetworkError,
  ConfigPushEnableWebhookStatusError,
  ConfigPushLoadConfigError,
  ConfigPushNetworkRestrictionsUpdateNetworkError,
  ConfigPushNetworkRestrictionsUpdateStatusError,
  ConfigPushSslEnforcementUpdateNetworkError,
  ConfigPushSslEnforcementUpdateStatusError,
  ConfigPushStorageUpdateNetworkError,
  ConfigPushStorageUpdateStatusError,
  ConfigPushWorkdirError,
} from "./push.errors.ts";
import {
  configPushPayloadFields,
  configPushTargetFields,
  pushConsentAction,
  pushCostLine,
  pushEnvSourcedLine,
  pushNotes,
  pushNotPushableLine,
  pushPayload,
  pushSummaryMessage,
  pushUpdatingLine,
  pushUpToDateLine,
  type PushEnvSourced,
  type PushForced,
  type PushUnencodable,
} from "./push.format.ts";
import { comparePaths, isRecord } from "./push.paths.ts";
import {
  PUSH_ADDON_GATES,
  PUSH_RESOURCES,
  changesCommunicated,
  planConfigPush,
  pushEnablesAddon,
  pushCostKey,
  pushResourceEnabled,
  pushResourceForPath,
  pushResponseBlock,
  type PushResource,
} from "./push.plan.ts";
import { resolveAuthSecrets, type PushSecretDecision } from "./push.secrets.ts";
import type { ConfigPushFlags } from "./push.command.ts";
import type { ConfigPushServiceResult } from "./push.types.ts";

/** The `services[].changes` union: encoded paths ∪ content extras ∪ secret paths the write
 *  actually sent, path-sorted. `sentSecretPaths` is `[]` for a skipped write. */
function pushServiceChanges(
  encoded: PushEncoded<unknown>,
  sentSecretPaths: ReadonlyArray<ReadonlyArray<string>>,
): ReadonlyArray<ReadonlyArray<string>> {
  return [...encoded.encoded, ...encoded.extras.map((extra) => extra.path), ...sentSecretPaths]
    .slice()
    .sort(comparePaths);
}

/** `services[].changes`, `secrets.sent`, and `secrets.skipped` must all read from the encoder's
 *  own `secretsEncoded` — a container carrying a `send` decision can still drop it as
 *  `unencodable`, so the raw decision list alone over-counts what was actually sent. */
function pushSentSecretPaths(encoded: PushEncoded<unknown>): ReadonlyArray<ReadonlyArray<string>> {
  return encoded.secretsEncoded ?? [];
}

/** The distinct paths an env variable supplied, each with that variable. */
function envSourcedPaths(
  paths: ReadonlyArray<ReadonlyArray<string>>,
  originFor: ConfigEnvOriginLookup,
): ReadonlyArray<PushEnvSourced> {
  const seen = new Set<string>();
  return paths.flatMap((path): ReadonlyArray<PushEnvSourced> => {
    const origin = originFor(path);
    const key = path.join(".");
    if (origin === undefined || seen.has(key)) return [];
    seen.add(key);
    return [{ path, origin }];
  });
}

/** `push.format.ts` must never see a secret's plaintext. */
function toSecretReport(decision: PushSecretDecision) {
  const { plaintext: _plaintext, ...report } = decision;
  return report;
}

interface ResourcePlan<E> {
  readonly changes: ReadonlyArray<ConfigChange>;
  readonly encoded: PushEncoded<unknown>;
  readonly secrets: ReadonlyArray<PushSecretDecision>;
  /** Absent when the encoder produced no body, so there is nothing to send. */
  readonly write: (() => Effect.Effect<unknown, E>) | undefined;
}

function planResource<Body, E>(
  changes: ReadonlyArray<ConfigChange>,
  encoded: PushEncoded<Body>,
  secrets: ReadonlyArray<PushSecretDecision>,
  write: (body: Body) => Effect.Effect<unknown, E>,
): ResourcePlan<E> {
  const { body } = encoded;
  return { changes, encoded, secrets, write: body === undefined ? undefined : () => write(body) };
}

/** Loads the resolved config once per push. */
const loadPushConfig = Effect.fn("config.push.loadConfig")(function* (
  cliSettings: { readonly workdir: string; readonly explicitWorkdir: boolean },
  ref: string,
) {
  const configValues = yield* CliConfigValues;
  const resolvedConfig = yield* configValues
    .load({
      workdir: cliSettings.workdir,
      projectRef: Option.some(ref),
      tolerateUnreadableLinkedRef: true,
    })
    .pipe(mapConfigLoadError(cliSettings, (message) => new ConfigPushLoadConfigError({ message })));
  if (!resolvedConfig.hasConfigFile) {
    return yield* new ConfigPushLoadConfigError({
      message: yield* missingProjectConfigMessageEffect(cliSettings),
    });
  }
  const loaded = resolvedConfig.loaded;
  yield* Effect.annotateCurrentSpan("config.remote_applied", loaded.appliedRemote !== undefined);
  const referenced = yield* resolvedConfig.envValues(envReferenceNames(loaded.document));
  return {
    loaded,
    lookup: (name: string) => referenced[name],
    dotenvPrivateKeys: resolvedConfig.dotenvPrivateKeys,
    originFor: configEnvOriginLookup(resolvedConfig.origins, (file) =>
      relativeConfigPath(cliSettings.workdir, file),
    ),
  };
});

export const configPush = Effect.fn("config.push")(function* (flags: ConfigPushFlags) {
  const output = yield* Output;
  const api = yield* CommandPlatformApi;
  const cliSettings = yield* CommandSettings;
  const linkedProjectCache = yield* LinkedProjectCache;
  const telemetryState = yield* TelemetryState;
  const fs = yield* FileSystem.FileSystem;

  // Set once ref resolution succeeds, so the linked-project cache write below only fires for
  // invocations that got that far.
  const resolvedRef = yield* Ref.make(Option.none<string>());

  yield* Effect.gen(function* () {
    // 0. The resolved `--workdir`/`SUPABASE_WORKDIR` must exist and be a directory before
    // anything else touches it: a workdir naming a regular file makes the project env load fail
    // with a confusing "failed to read environment file" error instead of this one.
    yield* validateWorkdirIsDirectory(cliSettings.workdir, fs).pipe(
      Effect.mapError((error) => new ConfigPushWorkdirError({ message: error.message })),
    );

    // 0.5. An explicit `--workdir`/`SUPABASE_WORKDIR` with no project fails here, before a
    // branch-name/UUID lookup burns a network round trip. A defaulted workdir is untouched: in a
    // config-less directory with no linked project, it instead fails with step 1's not-linked
    // error. Uses the same error message builder as the step-2 `loaded === null` branch.
    yield* requireExplicitWorkdirProject(cliSettings).pipe(
      Effect.mapError((error) => new ConfigPushLoadConfigError({ message: error.message })),
    );

    // 1. Resolve the push target. `resolvedRef` is set here so every failure path from the shared
    // resolver still flushes telemetry and, once a ref is known, writes the linked-project cache.
    //
    // Runs before the config load below: a `[remotes.<name>]` overlay is merged inside
    // the resolved config load before its one schema decode, so a base document that's invalid without its
    // overlay must never be decoded on its own — this can cost a network round trip before a
    // malformed `config.toml` is caught.
    const { ref, branch, parentRef, isDefault } = yield* resolveProjectTarget(flags, {
      detail: true,
    });
    yield* Ref.set(resolvedRef, Option.some(ref));
    yield* Effect.annotateCurrentSpan({
      "project.ref": ref,
      ...targetIsBranchAttribute({ branch, isDefault }),
    });

    // 2. Load config.toml with the resolved ref (a TOML parse error aborts before any network
    // call); the matching `[remotes.<name>]` overlay merges before decode in the same call.
    //
    // Needs the fully decoded document and value origins, which the tolerant
    // `db-config.toml-read.ts` subtree reader does not produce.
    const { loaded, lookup, dotenvPrivateKeys, originFor } = yield* loadPushConfig(
      cliSettings,
      ref,
    );
    // Printed from inside config load, before any command output.
    if (loaded.appliedRemote !== undefined) {
      yield* output.raw(
        `Loading config override: [remotes.${sanitizeInlineName(loaded.appliedRemote)}]\n`,
        "stderr",
      );
    }
    const config = loaded.config;

    // 3. Assert every `encrypted:` value in the document can be decrypted, even fields `config
    // push` never itself pushes — this must run before the cost matrix or any service is touched.
    const secretError = yield* Effect.sync(() =>
      assertDecryptableSecrets(loaded.document, lookup, dotenvPrivateKeys),
    ).pipe(Effect.withSpan("config.push.verifyDecryptable"));
    if (secretError !== undefined) {
      return yield* new ConfigPushLoadConfigError({ message: secretError });
    }

    // 4. Email content validation runs during config load, before any network call, and is
    // unconditional regardless of `config.auth.enabled` — that flag only toggles the local GoTrue
    // Docker service and doesn't gate whether `auth` is pushed, so gating this load too would
    // silently push empty content over a real hosted customization.
    const authEmailContent = yield* loadAuthEmailContent(cliSettings.workdir, config.auth.email);

    // 5. Determine the push target for the echo and the payload. The production branch is the
    // project itself and a UUID looked up with no link says nothing about what it is, so neither
    // is probed. Any other UUID carries no display name, so only a name lookup is fully known.
    const isUuid = branch !== undefined && BRANCH_UUID_PATTERN.test(branch);
    const knownBranch: ConfigPushKnownBranch | undefined =
      branch === undefined
        ? undefined
        : isDefault === true
          ? { kind: "production" }
          : isUuid && isDefault === undefined
            ? { kind: "unverified" }
            : !isUuid && parentRef !== undefined
              ? { kind: "name", branchName: branch, parentRef }
              : { kind: "uuid" };
    const target = yield* resolveConfigPushTarget(ref, { knownBranch }).pipe(
      Effect.withSpan("config.push.probeTarget"),
    );
    yield* Effect.annotateCurrentSpan("config.target_kind", target.kind);

    // 6. Cost matrix (prices the paid add-ons a push would enable).
    const cost = yield* getCostMatrix(ref);

    // 7. Read the project's effective configuration in one call. No spinner, matching the rest
    // of this command's stderr progress lines.
    const response = yield* api.executeRaw(operationDefinitions.v2GetProjectConfig, { ref }).pipe(
      Effect.mapError(
        (cause) =>
          new ConfigPushConfigReadNetworkError({
            message: `failed to read project config: ${cause}`,
          }),
      ),
    );
    if (response.status !== 200) {
      const body = sanitizeErrorBody(yield* response.text.pipe(Effect.orElseSucceed(() => "")));
      return yield* new ConfigPushConfigReadStatusError({
        status: response.status,
        body,
        message: configReadStatusMessage(response.status, body, ref, cliSettings.apiUrl),
      });
    }
    const responseJson = yield* response.json.pipe(
      Effect.mapError(
        (cause) =>
          new ConfigPushConfigReadNetworkError({
            message: `failed to read project config: ${cause}`,
            decode: true,
          }),
      ),
    );
    // A non-object body is an API-response problem, not something `fromApiProjectConfig` should
    // reject via its own typed error — checked once so reads below can index directly.
    if (!isRecord(responseJson)) {
      return yield* new ConfigPushConfigReadNetworkError({
        message: "failed to read project config: response body is not a JSON object",
        decode: true,
      });
    }

    // 8. Convert the response and classify against the local projection. A response the registry
    // cannot narrow, or a local document it cannot canonicalize, is a typed
    // `ProjectConfigParseError`; anything else is a defect.
    const remote = yield* configProjectConfigTry(() => fromApiProjectConfig(responseJson));

    const data = responseJson["data"];
    const attributes = isRecord(data) && isRecord(data["attributes"]) ? data["attributes"] : {};
    const scope = configApiScope(attributes);
    // Always echoed (family consistency with `config diff`/`config pull`),
    // not just when a block is missing.
    yield* output.raw(configScopeLine(scope), "stderr");
    if (scope.present.length === 0) {
      return yield* new ConfigPushConfigEmptyError({
        message: `The API returned no configuration for project ${sanitizeInlineName(ref)}; nothing was pushed. Check that your access token can read the project's configuration.`,
      });
    }
    const remoteAuthAttributes = isRecord(attributes["auth"]) ? attributes["auth"] : {};

    const local = yield* configProjectConfigTry(() => fromConfigDocument(loaded));
    const changeSet = yield* configProjectConfigTry(() =>
      diffProjectConfig({ local: loaded, remote }),
    ).pipe(Effect.withSpan("config.push.computeDiff"));
    yield* Effect.annotateCurrentSpan("change.count", changeSet.counts.total);

    // 9. Route pushable changes to their v1 write endpoint and resolve every
    // declared secret's send/unchanged/not_set/gated status.
    const plan = planConfigPush(changeSet);
    // Defensive: step 3's decrypt-or-abort check is expected to make this unreachable, but stays
    // a typed failure rather than an uncaught throw in case that invariant is ever violated.
    const secrets = yield* Effect.try({
      try: () =>
        resolveAuthSecrets({
          maskedPaths: changeSet.masked,
          config,
          local,
          remoteAuthAttributes,
          projectRef: ref,
          dotenvPrivateKeys,
        }),
      catch: (cause) =>
        new ConfigPushLoadConfigError({
          message: cause instanceof Error ? cause.message : String(cause),
        }),
    }).pipe(Effect.withSpan("config.push.resolveAuthSecrets"));
    const now = yield* DateTime.now;

    // Whether each resource's local gate is on, computed once for the resource loop below and
    // for excluding a gated-off resource's own `unmanaged` entries from the summary note.
    const resourceEnabled: Readonly<Record<PushResource, boolean>> = {
      api: pushResourceEnabled("api", config, local),
      "db.settings": pushResourceEnabled("db.settings", config, local),
      "db.network_restrictions": pushResourceEnabled("db.network_restrictions", config, local),
      "db.ssl_enforcement": pushResourceEnabled("db.ssl_enforcement", config, local),
      auth: pushResourceEnabled("auth", config, local),
      storage: pushResourceEnabled("storage", config, local),
    };

    const planFor = (resource: PushResource) => {
      const changes = plan.changesByResource[resource];
      switch (resource) {
        case "api":
          return planResource(changes, encodeApiBody({ changes, local, remote }), [], (body) =>
            api.v1.updatePostgrestServiceConfig({ ref, ...body }).pipe(
              Effect.catch(
                mapHttpError({
                  networkError: ConfigPushApiUpdateNetworkError,
                  statusError: ConfigPushApiUpdateStatusError,
                  networkMessage: (cause) => `failed to update API config: ${cause}`,
                  statusMessage: unexpectedStatusMessage,
                }),
              ),
            ),
          );
        case "db.settings":
          return planResource(
            changes,
            encodeDbSettingsBody({ changes, local, remote }),
            [],
            (body) =>
              api.v1.updatePostgresConfig({ ref, ...body }).pipe(
                Effect.catch(
                  mapHttpError({
                    networkError: ConfigPushDbUpdateNetworkError,
                    statusError: ConfigPushDbUpdateStatusError,
                    networkMessage: (cause) => `failed to update DB config: ${cause}`,
                    statusMessage: unexpectedStatusMessage,
                  }),
                ),
              ),
          );
        case "db.network_restrictions":
          return planResource(
            changes,
            encodeNetworkRestrictionsBody({ changes, local, remote }),
            [],
            (body) =>
              api.v1.updateNetworkRestrictions({ ref, ...body }).pipe(
                Effect.catch(
                  mapHttpError({
                    networkError: ConfigPushNetworkRestrictionsUpdateNetworkError,
                    statusError: ConfigPushNetworkRestrictionsUpdateStatusError,
                    networkMessage: (cause) =>
                      `failed to update network restrictions config: ${cause}`,
                    statusMessage: unexpectedStatusMessage,
                  }),
                ),
              ),
          );
        case "db.ssl_enforcement":
          return planResource(
            changes,
            encodeSslEnforcementBody({ changes, local, remote }),
            [],
            (body) =>
              api.v1.updateSslEnforcementConfig({ ref, ...body }).pipe(
                Effect.catch(
                  mapHttpError({
                    networkError: ConfigPushSslEnforcementUpdateNetworkError,
                    statusError: ConfigPushSslEnforcementUpdateStatusError,
                    networkMessage: (cause) => `failed to update SSL enforcement config: ${cause}`,
                    statusMessage: unexpectedStatusMessage,
                  }),
                ),
              ),
          );
        case "auth":
          return planResource(
            changes,
            encodeAuthBody({
              changes,
              local,
              remote,
              secrets,
              emailContent: authEmailContent,
              remoteAuthAttributes,
              config,
              now,
            }),
            secrets,
            (body) =>
              api.v1.updateAuthServiceConfig({ ref, ...body }).pipe(
                Effect.catch(
                  mapHttpError({
                    networkError: ConfigPushAuthUpdateNetworkError,
                    statusError: ConfigPushAuthUpdateStatusError,
                    networkMessage: (cause) => `failed to update Auth config: ${cause}`,
                    statusMessage: unexpectedStatusMessage,
                  }),
                ),
              ),
          );
        case "storage":
          return planResource(
            changes,
            encodeStorageBody({ changes, local, remote, config }),
            [],
            (body) =>
              api.v1.updateStorageConfig({ ref, ...body }).pipe(
                Effect.catch(
                  mapHttpError({
                    networkError: ConfigPushStorageUpdateNetworkError,
                    statusError: ConfigPushStorageUpdateStatusError,
                    networkMessage: (cause) => `failed to update Storage config: ${cause}`,
                    statusMessage: unexpectedStatusMessage,
                  }),
                ),
              ),
          );
      }
    };

    // 10. Encode every resource before anything is announced or written. A missing response
    // block makes a resource `unavailable` (nothing compared or written); a gated-off local
    // `enabled` flag makes it `disabled` — this can only happen for `db.network_restrictions` and
    // `db.ssl_enforcement`, since `auth`/`storage`'s local `enabled` toggle only controls a
    // Docker service the Management API has no concept of.
    const resourcePlans = new Map(
      PUSH_RESOURCES.filter(
        (resource) =>
          resourceEnabled[resource] && !scope.missing.includes(pushResponseBlock(resource)),
      ).map((resource) => [resource, planFor(resource)] as const),
    );
    const webhooksEnabled = config.experimental?.webhooks?.enabled === true;

    // Announced before the consent question so a `--yes` run still shows what the environment
    // supplied; only paths an encoder will actually send are counted, so an up-to-date resource
    // adds none.
    const envSourced = envSourcedPaths(
      [...resourcePlans.values()]
        .filter(({ encoded }) => encoded.body !== undefined)
        .flatMap(({ encoded }) => pushServiceChanges(encoded, pushSentSecretPaths(encoded))),
      originFor,
    );
    if (envSourced.length > 0) {
      yield* output.raw(pushEnvSourcedLine(envSourced), "stderr");
    }

    const services: Array<ConfigPushServiceResult> = [];
    const unsupported: Array<ReadonlyArray<string>> = [...plan.unsupported];
    const unencodable: Array<PushUnencodable> = [];
    const forced: Array<PushForced> = [];
    let authWriteRan = false;
    let secretsSent: ReadonlyArray<ReadonlyArray<string>> = [];

    for (const resource of PUSH_RESOURCES) {
      const resourcePlan = resourcePlans.get(resource);
      if (resourcePlan === undefined) continue;
      const { changes, encoded, secrets: resourceSecrets } = resourcePlan;
      unencodable.push(...encoded.unencodable);
      if (encoded.body !== undefined) {
        const communicated = changesCommunicated(changes, encoded.encoded);
        yield* output.raw(
          pushUpdatingLine({
            resource,
            changes: communicated,
            secrets: resourceSecrets.map(toSecretReport),
            secretsEncoded: encoded.secretsEncoded ?? [],
            extras: encoded.extras,
            forced: encoded.forced,
            originFor,
          }),
          "stderr",
        );
        for (const warning of configProviderDisableWarnings(communicated)) {
          yield* output.raw(`${warning}\n`, "stderr");
        }
      } else if (encoded.unencodable.length > 0) {
        yield* output.raw(pushNotPushableLine(resource, encoded.unencodable.length), "stderr");
      } else {
        yield* output.raw(pushUpToDateLine(resource), "stderr");
      }
    }
    if (webhooksEnabled) {
      yield* output.raw(
        `Would enable webhooks for project: ${sanitizeInlineName(ref)}\n`,
        "stderr",
      );
    }

    // 11. One consent covers every write; nothing is sent before it.
    const pendingServices: ReadonlyArray<ConfigPushServiceResult["service"]> = [
      ...PUSH_RESOURCES.filter((resource) => resourcePlans.get(resource)?.write !== undefined),
      ...(webhooksEnabled ? (["experimental.webhooks"] as const) : []),
    ];
    if (pendingServices.length > 0) {
      const authPlan = resourcePlans.get("auth");
      const costKeys = new Set([
        ...pendingServices.map((service) =>
          service === "experimental.webhooks" ? "webhooks" : pushCostKey(service),
        ),
        ...(authPlan?.write === undefined
          ? []
          : PUSH_ADDON_GATES.filter((gate) => pushEnablesAddon(authPlan.changes, gate, remote)).map(
              (gate) => gate.costKey,
            )),
      ]);
      const costLines = [...costKeys].flatMap((key) => {
        const item = cost.get(key);
        return item === undefined ? [] : [pushCostLine(item)];
      });
      if (costLines.length > 0) {
        yield* output.raw(costLines.join(""), "stderr");
      }
      yield* requireHostedMutationConsent({ action: pushConsentAction(pendingServices) });
    }

    // 12. Writes, in the established push order.
    for (const resource of PUSH_RESOURCES) {
      const resourcePlan = resourcePlans.get(resource);
      if (resourcePlan === undefined) {
        services.push({
          service: resource,
          status: scope.missing.includes(pushResponseBlock(resource)) ? "unavailable" : "disabled",
          changes: [],
        });
        continue;
      }
      const { encoded, write } = resourcePlan;
      if (write === undefined) {
        services.push({
          service: resource,
          status: encoded.unencodable.length > 0 ? "not_pushable" : "up_to_date",
          changes: [],
        });
        continue;
      }
      yield* Effect.gen(function* () {
        yield* Effect.annotateCurrentSpan("config.resource", resource);
        yield* write();
      }).pipe(Effect.withSpan("config.push.updateResource"));
      services.push({
        service: resource,
        status: "updated",
        changes: pushServiceChanges(encoded, pushSentSecretPaths(encoded)),
      });
      forced.push(...encoded.forced);
      if (resource === "auth") {
        authWriteRan = true;
        secretsSent = pushSentSecretPaths(encoded);
      }
    }

    // 12g. experimental.webhooks (no read/diff — a fixed enable-only POST).
    if (webhooksEnabled) {
      yield* api.v1.enableDatabaseWebhook({ ref }).pipe(
        Effect.catch(
          mapHttpError({
            networkError: ConfigPushEnableWebhookNetworkError,
            statusError: ConfigPushEnableWebhookStatusError,
            networkMessage: (cause) => `failed to enable webhooks: ${cause}`,
            statusMessage: (status, body) => `unexpected enable webhook status ${status}: ${body}`,
          }),
        ),
      );
      services.push({
        service: "experimental.webhooks",
        status: "updated",
        // No registry path backs this write, but the summary's property count (and a JSON
        // consumer inspecting `changes`) must still see it.
        changes: [["experimental", "webhooks", "enabled"]],
      });
    } else {
      services.push({ service: "experimental.webhooks", status: "disabled", changes: [] });
    }

    // 13. Notes (stderr, after the writes): unsupported, unencodable, and unmanaged
    // (count only, excluding a gated-off resource's own entries) declared properties, forced
    // companion defaults, empty/unresolved credentials, and the hands-off remote-only count.
    const unmanagedCount = changeSet.unmanaged.filter((changePath) => {
      const resourceForPath = pushResourceForPath(changePath);
      return resourceForPath === "unsupported" || resourceEnabled[resourceForPath];
    }).length;
    // An `unavailable` auth resource never read any credential, so the "not pushed" framing
    // below doesn't apply — that's specific to a credential whose own value was unresolved.
    const authUnavailable =
      services.find((service) => service.service === "auth")?.status === "unavailable";
    const notes = pushNotes({
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
    yield* Effect.annotateCurrentSpan(
      "resource.updated_count",
      services.filter((service) => service.status === "updated").length,
    );

    // 14. Machine-readable summary in `json` / `stream-json` mode.
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
        secretsSent,
        remoteOnly: plan.remoteOnly,
        scope,
        envSourced: envSourcedPaths(
          services
            .filter((service) => service.status === "updated")
            .flatMap((service) => service.changes),
          originFor,
        ),
      };
      yield* output.success(
        pushSummaryMessage(payloadInput),
        yield* withAnnouncedTarget({
          ...pushPayload(payloadInput),
          ...configPushPayloadFields(target),
          target: configPushTargetFields(target),
        }),
      );
    }
  }).pipe(
    Effect.ensuring(
      Ref.get(resolvedRef).pipe(
        Effect.flatMap(
          Option.match({
            onNone: () => Effect.void,
            onSome: (ref) => linkedProjectCache.cache(ref),
          }),
        ),
      ),
    ),
    Effect.ensuring(telemetryState.flush),
  );
});
