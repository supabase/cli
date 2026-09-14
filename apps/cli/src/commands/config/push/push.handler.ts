import { dirname } from "node:path";
import { fromApiProjectConfig, fromConfigDocument } from "@supabase/config";
import { diffProjectConfig, findCliProjectRoot, type ConfigChange } from "@supabase/config/effect";
import { operationDefinitions } from "@supabase/api/effect";
import { Clock, Effect, FileSystem, Option, Path } from "effect";

import { CommandPlatformApi } from "../../../auth/command-platform-api.service.ts";
import { CommandSettings } from "../../../config/command-settings.service.ts";
import { LinkedProjectCache } from "../../../telemetry/linked-project-cache.service.ts";
import { TelemetryState } from "../../../telemetry/telemetry-state.service.ts";
import { resolveYesWithProjectEnv } from "../../../command-internal/global-flags.ts";
import { CONTEXT_CANCELED_MESSAGE } from "../../../shared/output/errors.ts";
import { Output } from "../../../shared/output/output.service.ts";
import { Stdin } from "../../../shared/runtime/stdin.service.ts";
import { Tty } from "../../../shared/runtime/tty.service.ts";
import {
  assertDecryptableSecrets,
  loadProjectEnv,
} from "../../../command-internal/db-config.toml-read.ts";
import { resolveLinkedParentRef } from "../../../command-internal/parent-project-ref.ts";
import { BRANCH_UUID_PATTERN } from "../../../command-internal/ref-patterns.ts";
import {
  sanitizeInlineName,
  mapHttpError,
  sanitizeErrorBody,
  unexpectedStatusMessage,
} from "../../../command-internal/http-errors.ts";
import {
  configTargetErrorsFor,
  resolveConfigTarget,
} from "../../../command-internal/project-target.ts";
import { requireExplicitWorkdirProject } from "../../../command-internal/workdir-project.ts";
import { shouldSearchAncestors } from "../../../command-internal/workdir-search.ts";
import { validateWorkdirIsDirectory } from "../../../command-internal/workdir-validation.ts";
import { promptYesNo } from "../../../command-internal/prompt-yes-no.ts";
import { collectDotenvPrivateKeys } from "../../../command-internal/vault-decrypt.ts";
import { configApiScope, configScopeLine } from "../config.format.ts";
import { loadLocalConfig } from "../config.load.ts";
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
  ConfigPushBranchNotFoundError,
  ConfigPushBranchNotLinkedError,
  ConfigPushBranchNotReadyError,
  ConfigPushBranchResolveNetworkError,
  ConfigPushBranchResolveStatusError,
  ConfigPushCancelledError,
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
  ConfigPushParentRefInvalidError,
  ConfigPushSslEnforcementUpdateNetworkError,
  ConfigPushSslEnforcementUpdateStatusError,
  ConfigPushStorageUpdateNetworkError,
  ConfigPushStorageUpdateStatusError,
  ConfigPushWorkdirError,
} from "./push.errors.ts";
import {
  configPushBranchPromptLabel,
  configPushPayloadFields,
  configPushTargetLines,
  pushNotes,
  pushNotPushableLine,
  pushPayload,
  pushSummaryMessage,
  pushUpdatingLine,
  pushUpToDateLine,
  type PushForced,
  type PushUnencodable,
} from "./push.format.ts";
import { comparePaths, isRecord } from "./push.paths.ts";
import {
  PUSH_ADDON_GATES,
  PUSH_RESOURCES,
  applyMfaAddonDecline,
  changesCommunicated,
  planConfigPush,
  pushAddonPromptNeeded,
  pushPromptKey,
  pushResourceEnabled,
  pushResourceForPath,
  pushResponseBlock,
  type PushResource,
} from "./push.plan.ts";
import { resolveAuthSecrets, type PushSecretDecision } from "./push.secrets.ts";
import type { ConfigPushFlags } from "./push.command.ts";
import type { ConfigPushServiceResult } from "./push.types.ts";

/** The `services[].changes` union: encoded paths ∪ content extras ∪ secret paths the write
 *  actually sent, path-sorted. `sentSecretPaths` is `[]` for a declined/skipped write. */
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

/** `push.format.ts` must never see a secret's plaintext. */
function toSecretReport(decision: PushSecretDecision) {
  const { plaintext: _plaintext, ...report } = decision;
  return report;
}

const mapPushBranchResolveError = mapHttpError({
  networkError: ConfigPushBranchResolveNetworkError,
  statusError: ConfigPushBranchResolveStatusError,
  networkMessage: (cause) => `failed to resolve branch: ${cause}`,
  statusMessage: unexpectedStatusMessage,
});

/** Wires `resolveConfigTarget` (shared with `config diff`/`config pull`) to `config push`'s own
 *  tagged error classes. */
const configTargetErrors = configTargetErrorsFor({
  notLinked: ConfigPushBranchNotLinkedError,
  parentRefInvalid: ConfigPushParentRefInvalidError,
  branchNotFound: ConfigPushBranchNotFoundError,
  branchNotReady: ConfigPushBranchNotReadyError,
});

export const configPush = Effect.fn("config.push")(function* (flags: ConfigPushFlags) {
  const output = yield* Output;
  const api = yield* CommandPlatformApi;
  const cliSettings = yield* CommandSettings;
  const linkedProjectCache = yield* LinkedProjectCache;
  const telemetryState = yield* TelemetryState;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  // `--project-ref` accepts a project ref, or the name (or UUID) of a branch of the linked
  // project. An empty value is treated as absent, mirroring the resolver's own rule.
  const requestedRef = Option.filter(flags.projectRef, (value) => value.length > 0);

  // Set once ref resolution succeeds, so the linked-project cache write below only fires for
  // invocations that got that far.
  let resolvedRef: string | undefined;

  yield* Effect.gen(function* () {
    // 0. The resolved `--workdir`/`SUPABASE_WORKDIR` must exist and be a directory before
    // anything else touches it: a workdir naming a regular file makes `loadProjectEnv` throw
    // ENOTDIR with a confusing "failed to read environment file" error instead of this one.
    yield* validateWorkdirIsDirectory(cliSettings.workdir, fs).pipe(
      Effect.mapError((error) => new ConfigPushWorkdirError({ message: error.message })),
    );

    // `--yes`/`SUPABASE_YES` resolves against the project env (not just the flag + shell env), so
    // a `SUPABASE_YES` set only in `supabase/.env` auto-confirms. The project root climbs to find
    // it only when `--workdir` was defaulted; an explicit `--workdir ../other` pushes that
    // directory's own config.toml without climbing to another root's linked project.
    const projectRoot =
      (yield* findCliProjectRoot(cliSettings.workdir, {
        search: shouldSearchAncestors(cliSettings),
      })) ?? cliSettings.workdir;
    const projectEnv = yield* loadProjectEnv(fs, path, projectRoot);
    const yes = yield* resolveYesWithProjectEnv(projectEnv);
    // dotenvx private keys for decrypting `encrypted:` secrets, from the shell + project env;
    // `process.env` wins over `supabase/.env`, matching `db-config.toml-read.ts`.
    const dotenvPrivateKeys = collectDotenvPrivateKeys({ ...projectEnv, ...process.env });
    // Reached only when an `env(VAR)` literal survives `@supabase/config`'s own (narrower)
    // interpolation pass unresolved but this wider shell+project-env lookup can still resolve it.
    const secretEnvLookup = (name: string): string | undefined =>
      process.env[name] ?? projectEnv[name];

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
    // `loadCliConfig` before its one schema decode, so a base document that's invalid without its
    // overlay must never be decoded on its own — this can cost a network round trip before a
    // malformed `config.toml` is caught.
    const { ref, branch } = yield* resolveConfigTarget(
      requestedRef,
      configTargetErrors,
      mapPushBranchResolveError,
    );
    resolvedRef = ref;

    // 2. Load config.toml with the resolved ref (a TOML parse error aborts before any network
    // call); a matching `[remotes.<name>]` overlay merges before decode in the same call.
    //
    // Uses `loadLocalConfig` (needs the fully decoded config) rather than the tolerant
    // `db-config.toml-read.ts` subtree reader, converting its parse/duplicate-remote/missing-file
    // failures into this family's own tagged error.
    const loaded = yield* loadLocalConfig(
      cliSettings,
      ref,
      (message) => new ConfigPushLoadConfigError({ message }),
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
    //
    // Deprecated `auth.external.{linkedin,slack}` blocks are stripped from `loaded.document`
    // before this decode, so scan `removedDeprecatedExternalProviders` too, or a secret hiding in
    // one of them would skip the check.
    const secretError =
      assertDecryptableSecrets(loaded.document, secretEnvLookup, dotenvPrivateKeys) ??
      assertDecryptableSecrets(
        { auth: { external: loaded.removedDeprecatedExternalProviders } },
        secretEnvLookup,
        dotenvPrivateKeys,
      );
    if (secretError !== undefined) {
      return yield* new ConfigPushLoadConfigError({ message: secretError });
    }

    // Config lives at <projectRoot>/supabase/config.{toml,json}.
    const configProjectRoot = dirname(dirname(loaded.path));

    // 4. Email content validation runs during config load, before any network call, and is
    // unconditional regardless of `config.auth.enabled` — that flag only toggles the local GoTrue
    // Docker service and doesn't gate whether `auth` is pushed, so gating this load too would
    // silently push empty content over a real hosted customization.
    const authEmailContent = yield* Effect.try({
      try: () => loadAuthEmailContent(configProjectRoot, config.auth.email),
      catch: (cause) =>
        new ConfigPushLoadConfigError({
          message: cause instanceof Error ? cause.message : String(cause),
        }),
    });

    // 5. Determine the push target and, for a confirmed branch, gate the push behind an explicit
    // confirmation before any further network call. A target resolved from an explicit
    // `--project-ref <name-or-uuid>` this invocation skips the prompt, since the user already
    // expressed same-invocation intent.
    //
    // `resolveConfigTarget` returns only the raw branch name, not its resolved parent, so a name
    // target's parent is re-derived here via a second local-only read (env/cache/file, no
    // network) of the same chain that just resolved.
    let knownBranch: ConfigPushKnownBranch | undefined;
    if (branch !== undefined) {
      if (BRANCH_UUID_PATTERN.test(branch)) {
        knownBranch = { kind: "uuid" };
      } else {
        const parent = yield* resolveLinkedParentRef();
        knownBranch =
          parent.kind === "resolved"
            ? { kind: "name", branchName: branch, parentRef: parent.ref }
            : { kind: "uuid" };
      }
    }
    const target = yield* resolveConfigPushTarget(ref, { knownBranch });
    yield* output.raw(configPushTargetLines(target), "stderr");
    if (target.kind === "branch" && knownBranch === undefined) {
      const proceed = yield* promptYesNo(
        output,
        yes,
        configPushBranchPromptLabel(target),
        // Defaults `false`, unlike this file's other prompts: an unattended run without `--yes`
        // must decline a branch mutation rather than silently proceed.
        false,
      );
      if (!proceed) {
        return yield* new ConfigPushCancelledError({
          message: CONTEXT_CANCELED_MESSAGE,
          suggestion: "Pass --yes (or set SUPABASE_YES) to push to a branch without confirmation.",
        });
      }
    }

    // 6. Cost matrix (drives cost-aware prompts).
    const cost = yield* getCostMatrix(ref);

    // `promptYesNo` scans piped stdin on a non-TTY before falling back to the default.
    const keep = (name: string) =>
      Effect.gen(function* () {
        const item = cost.get(name);
        const title =
          item === undefined
            ? `Do you want to push ${name} config to remote?`
            : `Enabling ${item.name} will cost you ${item.price}. Keep it enabled?`;
        return yield* promptYesNo(output, yes, title, true);
      });

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
    );

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
    });
    const now = new Date(yield* Clock.currentTimeMillis);

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

    const services: Array<ConfigPushServiceResult> = [];
    const unsupported: Array<ReadonlyArray<string>> = [...plan.unsupported];
    const unencodable: Array<PushUnencodable> = [];
    const forced: Array<PushForced> = [];
    const declinedAddons: Array<string> = [];
    let authWriteRan = false;
    let secretsSent: ReadonlyArray<ReadonlyArray<string>> = [];

    // 10. Prints the resource's `Updating ...`/up-to-date/not-pushable line, prompts, writes, and
    // returns the result. `secretsForResource` is the resource's full secret-decision list; only
    // `auth` needs to pass anything besides `[]`.
    function applyResource<Body, E, R>(
      resource: PushResource,
      changes: ReadonlyArray<ConfigChange>,
      encoded: PushEncoded<Body>,
      secretsForResource: ReadonlyArray<PushSecretDecision>,
      write: (body: Body) => Effect.Effect<unknown, E, R>,
    ): Effect.Effect<ConfigPushServiceResult, E, R | Tty | Stdin> {
      return Effect.gen(function* () {
        if (encoded.body === undefined) {
          if (encoded.unencodable.length > 0) {
            yield* output.raw(pushNotPushableLine(resource, encoded.unencodable.length), "stderr");
            return { service: resource, status: "not_pushable", changes: [] };
          }
          yield* output.raw(pushUpToDateLine(resource), "stderr");
          return { service: resource, status: "up_to_date", changes: [] };
        }
        const body = encoded.body;
        const communicated = changesCommunicated(changes, encoded.encoded);
        yield* output.raw(
          pushUpdatingLine({
            resource,
            changes: communicated,
            secrets: secretsForResource.map(toSecretReport),
            secretsEncoded: encoded.secretsEncoded ?? [],
            extras: encoded.extras,
            forced: encoded.forced,
          }),
          "stderr",
        );
        if (yield* keep(pushPromptKey(resource))) {
          yield* write(body);
          const sentSecretPaths = pushSentSecretPaths(encoded);
          return {
            service: resource,
            status: "updated",
            changes: pushServiceChanges(encoded, sentSecretPaths),
          };
        }
        return {
          service: resource,
          status: "skipped",
          changes: pushServiceChanges(encoded, []),
        };
      });
    }

    // 11. Six resources, in the established push order. A missing response block makes a
    // resource `unavailable` (nothing compared or written); a gated-off local `enabled` flag
    // makes it `disabled` — this can only happen for `db.network_restrictions` and
    // `db.ssl_enforcement`, since `auth`/`storage`'s local `enabled` toggle only controls a
    // Docker service the Management API has no concept of.
    for (const resource of PUSH_RESOURCES) {
      if (scope.missing.includes(pushResponseBlock(resource))) {
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
          const encoded = encodeApiBody({ changes, local, remote });
          const result = yield* applyResource("api", changes, encoded, [], (body) =>
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
          services.push(result);
          unencodable.push(...encoded.unencodable);
          if (result.status === "updated") forced.push(...encoded.forced);
          break;
        }
        case "db.settings": {
          const changes = plan.changesByResource["db.settings"];
          const encoded = encodeDbSettingsBody({ changes, local, remote });
          const result = yield* applyResource("db.settings", changes, encoded, [], (body) =>
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
          services.push(result);
          unencodable.push(...encoded.unencodable);
          if (result.status === "updated") forced.push(...encoded.forced);
          break;
        }
        case "db.network_restrictions": {
          const changes = plan.changesByResource["db.network_restrictions"];
          const encoded = encodeNetworkRestrictionsBody({ changes, local, remote });
          const result = yield* applyResource(
            "db.network_restrictions",
            changes,
            encoded,
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
          services.push(result);
          unencodable.push(...encoded.unencodable);
          if (result.status === "updated") forced.push(...encoded.forced);
          break;
        }
        case "db.ssl_enforcement": {
          const changes = plan.changesByResource["db.ssl_enforcement"];
          const encoded = encodeSslEnforcementBody({ changes, local, remote });
          const result = yield* applyResource("db.ssl_enforcement", changes, encoded, [], (body) =>
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
          services.push(result);
          unencodable.push(...encoded.unencodable);
          if (result.status === "updated") forced.push(...encoded.forced);
          break;
        }
        case "auth": {
          // MFA addon cost filter runs before anything about auth is printed: a declined paid
          // addon carries an explicit disable when the remote currently has it on, or is dropped.
          let changes = plan.changesByResource.auth;
          for (const gate of PUSH_ADDON_GATES) {
            if (pushAddonPromptNeeded(changes, gate, remote) && !(yield* keep(gate.costKey))) {
              changes = applyMfaAddonDecline(changes, gate, remote);
              declinedAddons.push(gate.costKey);
            }
          }

          const encoded = encodeAuthBody({
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
                mapHttpError({
                  networkError: ConfigPushAuthUpdateNetworkError,
                  statusError: ConfigPushAuthUpdateStatusError,
                  networkMessage: (cause) => `failed to update Auth config: ${cause}`,
                  statusMessage: unexpectedStatusMessage,
                }),
              ),
            ),
          );
          services.push(result);
          unencodable.push(...encoded.unencodable);
          authWriteRan = result.status === "updated";
          secretsSent = pushSentSecretPaths(encoded);
          if (result.status === "updated") forced.push(...encoded.forced);
          break;
        }
        case "storage": {
          const changes = plan.changesByResource.storage;
          const encoded = encodeStorageBody({ changes, local, remote, config });
          const result = yield* applyResource("storage", changes, encoded, [], (body) =>
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
          services.push(result);
          unencodable.push(...encoded.unencodable);
          if (result.status === "updated") forced.push(...encoded.forced);
          break;
        }
      }
    }

    // 11g. experimental.webhooks (no read/diff — a fixed enable-only POST).
    if (config.experimental?.webhooks?.enabled !== true) {
      services.push({ service: "experimental.webhooks", status: "disabled", changes: [] });
    } else {
      yield* output.raw(`Enabling webhooks for project: ${sanitizeInlineName(ref)}\n`, "stderr");
      if (yield* keep("webhooks")) {
        yield* api.v1.enableDatabaseWebhook({ ref }).pipe(
          Effect.catch(
            mapHttpError({
              networkError: ConfigPushEnableWebhookNetworkError,
              statusError: ConfigPushEnableWebhookStatusError,
              networkMessage: (cause) => `failed to enable webhooks: ${cause}`,
              statusMessage: (status, body) =>
                `unexpected enable webhook status ${status}: ${body}`,
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
        services.push({ service: "experimental.webhooks", status: "skipped", changes: [] });
      }
    }

    // 12. Notes (stderr, after the resource loop): unsupported, unencodable, and unmanaged
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

    // 13. Machine-readable summary in `json` / `stream-json` mode.
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
        declinedAddons,
        remoteOnly: plan.remoteOnly,
        scope,
      };
      yield* output.success(pushSummaryMessage(payloadInput), {
        ...pushPayload(payloadInput),
        ...configPushPayloadFields(target),
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
