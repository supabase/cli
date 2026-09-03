import { dirname } from "node:path";
import { fromApiProjectConfig, fromConfigDocument, ProjectConfigParseError } from "@supabase/config";
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
import { legacyConfigDiffScope, legacyConfigDiffScopeLine } from "../diff/diff.format.ts";
import { legacyConfigReadStatusMessage } from "../config.read-status.ts";
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
  legacyPushPayload,
  legacyPushUpdatingLine,
  legacyPushUpToDateLine,
} from "./push.format.ts";
import {
  legacyPlanConfigPush,
  legacyPushPromptKey,
  type LegacyPushResource,
} from "./push.plan.ts";
import { legacyResolveAuthSecrets, type LegacyPushSecretDecision } from "./push.secrets.ts";
import type { LegacyConfigPushFlags } from "./push.command.ts";
import type { LegacyConfigPushServiceResult } from "./push.types.ts";

// Every update path shares this generic status-message shape; list-addons and
// enable-webhook keep their own prefixes (see push.errors.ts).
const readStatusMessage = (status: number, body: string) => `unexpected status ${status}: ${body}`;

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function samePath(a: ReadonlyArray<string>, b: ReadonlyArray<string>): boolean {
  return a.length === b.length && a.every((segment, index) => segment === b[index]);
}

function pathIn(path: ReadonlyArray<string>, paths: ReadonlyArray<ReadonlyArray<string>>): boolean {
  return paths.some((candidate) => samePath(candidate, path));
}

/** The routed change list, narrowed to the paths a resource's body actually communicated. */
function changesCommunicated(
  changes: ReadonlyArray<ConfigChange>,
  encoded: ReadonlyArray<ReadonlyArray<string>>,
): ReadonlyArray<ConfigChange> {
  return changes.filter((change) => pathIn(change.path, encoded));
}

/**
 * Drops a paid MFA addon's `verify_enabled`/`enroll_enabled` changes from the
 * routed auth change list — used when the cost-aware prompt for that addon is
 * declined. Omitting the pair leaves the remote's current (already disabled)
 * state untouched, rather than sending an explicit disable.
 */
function dropMfaAddonChanges(
  changes: ReadonlyArray<ConfigChange>,
  addon: "phone" | "web_authn",
): ReadonlyArray<ConfigChange> {
  const verifyPath = ["auth", "mfa", addon, "verify_enabled"];
  const enrollPath = ["auth", "mfa", addon, "enroll_enabled"];
  return changes.filter(
    (change) => !samePath(change.path, verifyPath) && !samePath(change.path, enrollPath),
  );
}

/**
 * Wraps one of `@supabase/config`'s three convergence calls
 * (`fromApiProjectConfig`, `fromConfigDocument`, `diffProjectConfig`), each of
 * which throws a typed `ProjectConfigParseError` on an out-of-domain
 * response/document the mapping registry cannot canonicalize. Anything else
 * escaping one of these calls would be a bug in this package pairing, so it
 * stays a defect — mirrors `diff/diff.handler.ts`'s inline `Effect.try` +
 * `Effect.catch` pattern, hoisted here since three call sites in this handler
 * share it.
 */
export function legacyPushProjectConfigTry<A>(
  thunk: () => A,
): Effect.Effect<A, ProjectConfigParseError> {
  return Effect.try({ try: thunk, catch: (cause) => cause }).pipe(
    Effect.catch((cause) =>
      cause instanceof ProjectConfigParseError ? Effect.fail(cause) : Effect.die(cause),
    ),
  );
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
      yield* output.raw(`Loading config override: [remotes.${loaded.appliedRemote}]\n`, "stderr");
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

    yield* output.raw(`Pushing config to project: ${ref}\n`, "stderr");

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

    // 4. Convert the response and classify against the local projection.
    // A response the registry cannot narrow, or a local document it cannot
    // canonicalize, is a typed `ProjectConfigParseError`; anything else is a
    // defect (see `legacyPushProjectConfigTry`).
    const remote = yield* legacyPushProjectConfigTry(() => fromApiProjectConfig(responseJson));

    const data = isRecord(responseJson) ? responseJson["data"] : undefined;
    const attributes = isRecord(data) && isRecord(data["attributes"]) ? data["attributes"] : {};
    const scope = legacyConfigDiffScope(attributes);
    if (scope.missing.length > 0) {
      yield* output.raw(legacyConfigDiffScopeLine(scope), "stderr");
    }
    const remoteAuthAttributes = isRecord(attributes["auth"]) ? attributes["auth"] : {};

    const local = yield* legacyPushProjectConfigTry(() => fromConfigDocument(loaded));
    const changeSet = yield* legacyPushProjectConfigTry(() =>
      diffProjectConfig({ local: loaded, remote }),
    );

    // 5. Route pushable changes to their v1 write endpoint and resolve every
    // declared secret's send/unchanged/not_set/gated status.
    const plan = legacyPlanConfigPush(changeSet);
    const secrets = legacyResolveAuthSecrets({
      maskedPaths: changeSet.masked,
      config,
      local,
      remoteAuthAttributes,
      projectRef: ref,
      dotenvPrivateKeys,
    });
    const now = new Date(yield* Clock.currentTimeMillis);

    const services: Array<LegacyConfigPushServiceResult> = [];
    const unsupported: Array<ReadonlyArray<string>> = [...plan.unsupported];

    // 6. Prints the resource's `Updating ... with config:` block (or the
    // up-to-date line), prompts, writes, and returns the service's result.
    // `secretsForResource` is the resource's full (unfiltered) secret list —
    // `legacyPushUpdatingLine` renders only `status === "send"` entries, so
    // non-auth resources simply pass `[]`.
    function applyResource<Body, E, R>(
      resource: LegacyPushResource,
      changes: ReadonlyArray<ConfigChange>,
      encoded: LegacyPushEncoded<Body>,
      secretsForResource: ReadonlyArray<LegacyPushSecretDecision>,
      write: (body: Body) => Effect.Effect<unknown, E, R>,
    ): Effect.Effect<LegacyConfigPushServiceResult, E, R | Tty | Stdin> {
      return Effect.gen(function* () {
        if (encoded.body === undefined) {
          yield* output.raw(legacyPushUpToDateLine(resource), "stderr");
          return { service: resource, status: "up_to_date", changes: [] };
        }
        const body = encoded.body;
        const communicated = changesCommunicated(changes, encoded.encoded);
        yield* output.raw(legacyPushUpdatingLine(resource, communicated, secretsForResource), "stderr");
        if (yield* keep(legacyPushPromptKey(resource))) {
          yield* write(body);
          return { service: resource, status: "updated", changes: encoded.encoded };
        }
        return { service: resource, status: "skipped", changes: encoded.encoded };
      });
    }

    // 7a. api (no gate — `api.enabled` itself is a pushable leaf).
    {
      const changes = plan.changesByResource.get("api") ?? [];
      const encoded = legacyEncodeApiBody({ changes, local, config });
      services.push(
        yield* applyResource("api", changes, encoded, [], (body) =>
          api.v1.updatePostgrestServiceConfig({ ref, ...body }).pipe(
            Effect.catch(
              mapLegacyHttpError({
                networkError: LegacyConfigPushApiUpdateNetworkError,
                statusError: LegacyConfigPushApiUpdateStatusError,
                networkMessage: (cause) => `failed to update API config: ${cause}`,
                statusMessage: readStatusMessage,
              }),
            ),
          ),
        ),
      );
      unsupported.push(...encoded.unencodable);
    }

    // 7b. db.settings (no gate — always processed).
    {
      const changes = plan.changesByResource.get("db.settings") ?? [];
      const encoded = legacyEncodeDbSettingsBody({ changes, local, config });
      services.push(
        yield* applyResource("db.settings", changes, encoded, [], (body) =>
          api.v1.updatePostgresConfig({ ref, ...body }).pipe(
            Effect.catch(
              mapLegacyHttpError({
                networkError: LegacyConfigPushDbUpdateNetworkError,
                statusError: LegacyConfigPushDbUpdateStatusError,
                networkMessage: (cause) => `failed to update DB config: ${cause}`,
                statusMessage: readStatusMessage,
              }),
            ),
          ),
        ),
      );
      unsupported.push(...encoded.unencodable);
    }

    // 7c. db.network_restrictions (gated on the decoded config's `enabled`).
    if (!config.db.network_restrictions.enabled) {
      services.push({ service: "db.network_restrictions", status: "disabled", changes: [] });
    } else {
      const changes = plan.changesByResource.get("db.network_restrictions") ?? [];
      const encoded = legacyEncodeNetworkRestrictionsBody({ changes, local, config });
      services.push(
        yield* applyResource("db.network_restrictions", changes, encoded, [], (body) =>
          api.v1.updateNetworkRestrictions({ ref, ...body }).pipe(
            Effect.catch(
              mapLegacyHttpError({
                networkError: LegacyConfigPushNetworkRestrictionsUpdateNetworkError,
                statusError: LegacyConfigPushNetworkRestrictionsUpdateStatusError,
                networkMessage: (cause) => `failed to update network restrictions config: ${cause}`,
                statusMessage: readStatusMessage,
              }),
            ),
          ),
        ),
      );
      unsupported.push(...encoded.unencodable);
    }

    // 7d. db.ssl_enforcement (gated on the local projection's presence —
    // `local.db?.ssl_enforcement` is only defined when `[db.ssl_enforcement]`
    // is declared).
    if (local.db?.ssl_enforcement === undefined) {
      services.push({ service: "db.ssl_enforcement", status: "disabled", changes: [] });
    } else {
      const changes = plan.changesByResource.get("db.ssl_enforcement") ?? [];
      const encoded = legacyEncodeSslEnforcementBody({ changes, local, config });
      services.push(
        yield* applyResource("db.ssl_enforcement", changes, encoded, [], (body) =>
          api.v1.updateSslEnforcementConfig({ ref, ...body }).pipe(
            Effect.catch(
              mapLegacyHttpError({
                networkError: LegacyConfigPushSslEnforcementUpdateNetworkError,
                statusError: LegacyConfigPushSslEnforcementUpdateStatusError,
                networkMessage: (cause) => `failed to update SSL enforcement config: ${cause}`,
                statusMessage: readStatusMessage,
              }),
            ),
          ),
        ),
      );
      unsupported.push(...encoded.unencodable);
    }

    // 7e. auth (gated on the decoded config's `enabled`; MFA addon cost
    // filter runs before anything about auth is printed).
    if (!config.auth.enabled) {
      services.push({ service: "auth", status: "disabled", changes: [] });
    } else {
      let changes = plan.changesByResource.get("auth") ?? [];
      const phoneVerify = changes.find((change) =>
        samePath(change.path, ["auth", "mfa", "phone", "verify_enabled"]),
      );
      if (phoneVerify?.local === true && !(yield* keep("auth_mfa_phone"))) {
        changes = dropMfaAddonChanges(changes, "phone");
      }
      const webAuthnVerify = changes.find((change) =>
        samePath(change.path, ["auth", "mfa", "web_authn", "verify_enabled"]),
      );
      if (webAuthnVerify?.local === true && !(yield* keep("auth_mfa_web_authn"))) {
        changes = dropMfaAddonChanges(changes, "web_authn");
      }

      const encoded = legacyEncodeAuthBody({
        changes,
        local,
        config,
        secrets,
        emailContent: authEmailContent,
        remoteAuthAttributes,
        now,
      });
      services.push(
        yield* applyResource("auth", changes, encoded, secrets, (body) =>
          api.v1.updateAuthServiceConfig({ ref, ...body }).pipe(
            Effect.catch(
              mapLegacyHttpError({
                networkError: LegacyConfigPushAuthUpdateNetworkError,
                statusError: LegacyConfigPushAuthUpdateStatusError,
                networkMessage: (cause) => `failed to update Auth config: ${cause}`,
                statusMessage: readStatusMessage,
              }),
            ),
          ),
        ),
      );
      unsupported.push(...encoded.unencodable);
    }

    // 7f. storage (gated on the decoded config's `enabled`).
    if (!config.storage.enabled) {
      services.push({ service: "storage", status: "disabled", changes: [] });
    } else {
      const changes = plan.changesByResource.get("storage") ?? [];
      const encoded = legacyEncodeStorageBody({ changes, local, config });
      services.push(
        yield* applyResource("storage", changes, encoded, [], (body) =>
          api.v1.updateStorageConfig({ ref, ...body }).pipe(
            Effect.catch(
              mapLegacyHttpError({
                networkError: LegacyConfigPushStorageUpdateNetworkError,
                statusError: LegacyConfigPushStorageUpdateStatusError,
                networkMessage: (cause) => `failed to update Storage config: ${cause}`,
                statusMessage: readStatusMessage,
              }),
            ),
          ),
        ),
      );
      unsupported.push(...encoded.unencodable);
    }

    // 7g. experimental.webhooks (no read/diff — a fixed enable-only POST).
    if (config.experimental?.webhooks?.enabled !== true) {
      services.push({ service: "experimental.webhooks", status: "disabled", changes: [] });
    } else {
      yield* output.raw(`Enabling webhooks for project: ${ref}\n`, "stderr");
      if (yield* keep("webhooks")) {
        yield* api.v1.enableDatabaseWebhook({ ref }).pipe(
          Effect.catch(
            mapLegacyHttpError({
              networkError: LegacyConfigPushEnableWebhookNetworkError,
              statusError: LegacyConfigPushEnableWebhookStatusError,
              networkMessage: (cause) => `failed to enable webhooks: ${cause}`,
              statusMessage: (status, body) => `unexpected enable webhook status ${status}: ${body}`,
            }),
          ),
        );
        services.push({ service: "experimental.webhooks", status: "updated", changes: [] });
      } else {
        services.push({ service: "experimental.webhooks", status: "skipped", changes: [] });
      }
    }

    // 8. Notes (stderr, after the resource loop) — declared-but-unpushable
    // properties, declared-but-unmanaged properties, empty/unresolved
    // credentials, and the hands-off remote-only count.
    const notes = legacyPushNotes({
      unsupported,
      unmanaged: changeSet.unmanaged,
      secretsNotSet: secrets.filter((secret) => secret.status === "not_set").map((secret) => secret.path),
      remoteOnly: plan.remoteOnly,
    });
    if (notes !== "") {
      yield* output.raw(notes, "stderr");
    }

    // 9. Machine-readable summary in `json` / `stream-json` mode.
    if (output.format !== "text") {
      yield* output.success(
        "",
        legacyPushPayload({
          projectRef: ref,
          services,
          unsupported,
          unmanaged: changeSet.unmanaged,
          secrets,
          remoteOnly: plan.remoteOnly,
          scope,
        }),
      );
    }
  }).pipe(Effect.ensuring(linkedProjectCache.cache(ref)), Effect.ensuring(telemetryState.flush));
});
