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
} from "../../../command-internal/http-errors.ts";
import { requireExplicitWorkdirProject } from "../../../command-internal/workdir-project.ts";
import { shouldSearchAncestors } from "../../../command-internal/workdir-search.ts";
import { validateWorkdirIsDirectory } from "../../../command-internal/workdir-validation.ts";
import { promptYesNo } from "../../../command-internal/prompt-yes-no.ts";
import { collectDotenvPrivateKeys } from "../../../command-internal/vault-decrypt.ts";
import { configApiScope, configScopeLine } from "../config.format.ts";
import { loadLocalConfig } from "../config.load.ts";
import { configProjectConfigTry } from "../config.project-config.ts";
import { configReadStatusMessage, unexpectedStatusMessage } from "../config.read-status.ts";
import { configTargetErrorsFor, resolveConfigTarget } from "../config.target.ts";
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

/** The `services[].changes` union (D8): encoded paths ∪ content extras ∪ secret paths the write
 * ACTUALLY sent, path-sorted. `sentSecretPaths` is `[]` for a declined/skipped write. */
function pushServiceChanges(
  encoded: PushEncoded<unknown>,
  sentSecretPaths: ReadonlyArray<ReadonlyArray<string>>,
): ReadonlyArray<ReadonlyArray<string>> {
  return [...encoded.encoded, ...encoded.extras.map((extra) => extra.path), ...sentSecretPaths]
    .slice()
    .sort(comparePaths);
}

/** `services[].changes`, `secrets.sent`, and `secrets.skipped` must all read from the same
 * source: the encoder's own `secretsEncoded` — the container that carries a `send` decision can
 * still drop it as `unencodable`, so the raw decision list alone over-counts what a write actually
 * placed in the body. */
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

/** Error construction for `resolveConfigTarget` (`../config.target.ts`, shared with
 *  `config diff`/`config pull`), keeping `config push`'s own tagged error classes; the
 *  message wording is shared there. */
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

  yield* Effect.gen(function* () {
    // 0. The resolved `--workdir`/`SUPABASE_WORKDIR` must exist and be a
    // directory before anything else touches it. The project-root probe,
    // project-env load, and private-key collection immediately below used to
    // run BEFORE this check, in the outer function body — harmless for a
    // missing directory (`loadProjectEnv` tolerates `NotFound`), but not
    // for a `--workdir` that names a regular FILE: `loadProjectEnv`
    // does not tolerate ENOTDIR, so it surfaced a confusing
    // "failed to read environment file: ..." error instead of this one, and
    // it did so OUTSIDE the `Effect.ensuring(telemetryState.flush)` wrapper
    // below. Moved here so both failure shapes are caught by the same check,
    // and telemetry flushes for either one.
    yield* validateWorkdirIsDirectory(cliSettings.workdir, fs).pipe(
      Effect.mapError((error) => new ConfigPushWorkdirError({ message: error.message })),
    );

    // `--yes` OR `SUPABASE_YES`. `config push` imports `supabase/.env` before
    // the confirmation prompt reads the yes flag, so a `SUPABASE_YES` set only
    // in `supabase/.env` auto-confirms. Resolve against the project env, not
    // just the flag + shell env. Load it from the resolved project root
    // (climbing only when `cliSettings.workdir` was defaulted, same as
    // `loadCliConfig` below — an explicit `--workdir`/`SUPABASE_WORKDIR` is
    // authoritative and never climbs, see `shouldSearchAncestors`), so a
    // push from a subdirectory of a defaulted workdir still reads the project
    // root's `supabase/.env`.
    // Resolved against `cliSettings.workdir` — the same root the project-ref
    // resolver and the linked-project cache use — so `--workdir ../other`
    // pushes `../other`'s config.toml, never the invoking directory's file to
    // another root's linked project.
    const projectRoot =
      (yield* findCliProjectRoot(cliSettings.workdir, {
        search: shouldSearchAncestors(cliSettings),
      })) ?? cliSettings.workdir;
    const projectEnv = yield* loadProjectEnv(fs, path, projectRoot);
    const yes = yield* resolveYesWithProjectEnv(projectEnv);
    // dotenvx private keys for decrypting `encrypted:` secrets, from the shell
    // + project env — same source/precedence as `db-config.toml-read.ts`
    // (`process.env` wins over `supabase/.env`).
    const dotenvPrivateKeys = collectDotenvPrivateKeys({ ...projectEnv, ...process.env });
    // Only reached by `assertDecryptableSecrets` below for an `env(VAR)` literal that
    // survives `loaded.document`'s own (`@supabase/config`) interpolation pass unresolved — i.e.
    // when this wider env source resolves `VAR` but `@supabase/config`'s
    // narrower one (`supabase/.env`/`.env.local` only) didn't. Practically
    // unreachable in the same narrow way the CLI-1489 comment below already documents for
    // non-secret fields; kept for parity with the shared function's other caller
    // (`db-config.toml-read.ts`, whose pre-interpolation document relies on this).
    const secretEnvLookup = (name: string): string | undefined =>
      process.env[name] ?? projectEnv[name];

    // 0.5. An explicit `--workdir`/`SUPABASE_WORKDIR` that holds no project
    // fails HERE, before target resolution burns a branch-name/UUID lookup's
    // network round trip — a pure `fs.exists` probe with no schema decode,
    // so it does not touch the "only ONE decode may ever run" invariant step
    // 2 below relies on. A DEFAULTED workdir is untouched (today, `config
    // push` in a config-less directory with no linked project fails with the
    // not-linked error from step 1, not a config error) — deliberately kept,
    // since making this check unconditional would be an established-behavior
    // change outside this fix's scope. Message is identical to the step-2
    // `loaded === null` branch below (same builder), so the user-visible
    // failure text is unchanged, only earlier in time.
    yield* requireExplicitWorkdirProject(cliSettings).pipe(
      Effect.mapError((error) => new ConfigPushLoadConfigError({ message: error.message })),
    );

    // 1. Resolve the push target. `--project-ref` accepts a project ref, or
    // the name (or UUID) of a branch of the linked project (CLI-2167/CLI-2289) —
    // `resolveConfigTarget` (`../config.target.ts`, Hoist Before You
    // Duplicate, shared with `config diff`/`config pull`). This is ALSO
    // where `resolvedRef` is set, so every one of the shared resolver's
    // failure paths (not linked, invalid parent, not found, not ready,
    // network/status) still flushes telemetry and, once a ref is known,
    // writes the linked-project cache.
    //
    // Deliberately runs BEFORE the config load below: a `[remotes.<name>]`
    // overlay is merged INSIDE `loadCliConfig` itself (driven by
    // `projectRef`) before its one full schema decode, and only ONE decode
    // may ever run — a base document that's schema-invalid without its
    // overlay must never be evaluated on its own, or a config that's only
    // valid once the matching remote applies would be wrongly rejected. A
    // branch name/UUID resolution may therefore cost a network round trip
    // before a malformed `config.toml` is caught — an accepted, narrow
    // tradeoff (matches this command's own pre-CLI-2168 behavior, which
    // always resolved before loading).
    const { ref, branch } = yield* resolveConfigTarget(
      requestedRef,
      configTargetErrors,
      mapPushBranchResolveError,
    );
    resolvedRef = ref;

    // 2. Load config.toml with the resolved ref (TOML parse error aborts
    // before any network call). A matching `[remotes.<name>]` block's
    // overlay is merged before decode in the SAME call — see the note
    // above.
    //
    // NOTE (CLI-1489): `config push` needs the fully decoded config (every
    // service subset), so it uses `loadLocalConfig` (`../config.load.ts`,
    // shared with `config diff`/`config pull`) rather than the tolerant
    // `db-config.toml-read.ts` subtree reader. The underlying
    // `loadCliConfig` raises `CliConfigParseError` on `env(...)` refs over
    // numeric/bool fields; `loadLocalConfig` catches it (and a
    // duplicate-remote/missing-file failure) and converts it to this
    // family's own tagged error via the shared message shapes — including
    // the ancestor-search decision (`shouldSearchAncestors`), so an
    // explicit `--workdir`/`SUPABASE_WORKDIR` with no project here never
    // silently falls back to an ancestor project's config (CLI-2285).
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

    // 3. Assert every `config.Secret`-typed `encrypted:` value in the
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

    // 4. Email content validation runs during config load, before any network
    // call. Unconditional regardless of `config.auth.enabled` (CLI-2314,
    // review round): that flag is the local-only GoTrue Docker toggle and no
    // longer gates whether the `auth` resource is pushed (`push.plan.ts`'s
    // `pushResourceEnabled`) — gating this load the same way it used
    // to would silently push empty template/notification content over a
    // real hosted customization whenever `auth.enabled = false`, even though
    // every other declared `auth.*` field is pushed normally in that case.
    const authEmailContent = yield* Effect.try({
      try: () => loadAuthEmailContent(configProjectRoot, config.auth.email),
      catch: (cause) =>
        new ConfigPushLoadConfigError({
          message: cause instanceof Error ? cause.message : String(cause),
        }),
    });

    // 5. Determine the push target (plain project vs. branch vs. unknown)
    // and, for a CONFIRMED branch, gate the push behind an explicit
    // confirmation before any further network call — including the cost
    // matrix below (CLI-2168). A target resolved from an EXPLICIT
    // `--project-ref <name-or-uuid>` this invocation (`branch`, from the
    // shared resolver above) skips the prompt: the user already expressed
    // same-invocation intent, so re-confirming the exact string they just
    // typed is friction with no safety benefit. The target-echo line below
    // always prints regardless of kind.
    //
    // `resolveConfigTarget` (shared with `config diff`/`config pull`,
    // neither of which needs a branch's PARENT ref) returns only the raw
    // `branch` string the user named, not its resolved parent. A UUID
    // target genuinely has no parent to give (`GET /v1/branches/{id}`
    // resolves it alone) — `{kind: "uuid"}`. A NAME target's parent WAS
    // resolved internally to look it up, just not returned; re-deriving it
    // here via `resolveLinkedParentRef()` is a second LOCAL-ONLY read
    // (env/cache/file, no network) of the exact same chain that just
    // resolved moments ago, so it can only disagree if something rewrote
    // the linked state mid-command — safe to treat as unreachable.
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
        // Deliberately `false` (unlike this file's other prompts, which
        // default `true`): an unattended run (CI, an agent, a script)
        // without `--yes` must safely decline a branch mutation rather than
        // silently proceed. `--yes`/`SUPABASE_YES` (`yes`, resolved above)
        // is the intended override.
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
        return yield* promptYesNo(output, yes, title, true);
      });

    // 7. Read the project's effective configuration once — replaces the
    // former five per-service `GET /v1/...` calls. No spinner (matches the
    // rest of this command's stderr progress lines).
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
    // A 200 response whose body isn't even a JSON object is an API-response
    // problem, not something `fromApiProjectConfig` should have to reject
    // via its own typed error — checked once, up front, so every read below
    // can index `responseJson` directly.
    if (!isRecord(responseJson)) {
      return yield* new ConfigPushConfigReadNetworkError({
        message: "failed to read project config: response body is not a JSON object",
        decode: true,
      });
    }

    // 8. Convert the response and classify against the local projection.
    // A response the registry cannot narrow, or a local document it cannot
    // canonicalize, is a typed `ProjectConfigParseError`; anything else is a
    // defect (`configProjectConfigTry`, shared with `config
    // diff`/`config pull`).
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
    // Defensive: the document-wide decrypt-or-abort pre-check above (step 3)
    // is expected to make this unreachable — kept as a typed failure, in the
    // same `failed to parse config: <cause>` shape, rather than an uncaught
    // throw, in case that invariant is ever violated (see push.secret.ts).
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

    // Whether each resource's local gate is on — computed once, both for the
    // resource loop below and for excluding a gated-off resource's own
    // `unmanaged` entries from the summary note (D5).
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

    // 10. Prints the resource's `Updating ... with config:` block (or the
    // up-to-date/not-pushable line), prompts, writes, and returns the
    // service's result. `secretsForResource` is the resource's full
    // (unfiltered) secret-decision list — `pushUpdatingLine` renders
    // only `send`/`not_set` entries, so non-auth resources simply pass `[]`.
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

    // 11. Six resources, in the established push order. A resource whose
    // response block was omitted from the read is `unavailable` — nothing is
    // compared, nothing is written (S5/D2); the `Comparison scope:` line
    // above already explains why. Otherwise, a gated-off resource is
    // `disabled` — today (CLI-2314) this can fire for two of the six:
    // `db.network_restrictions`, whose own `enabled` flag is a genuine
    // hosted-side management opt-out (the projection's disabled-sentinel
    // prune still removes its `allowed_cidrs`/`allowed_cidrs_v6` siblings
    // before diffing, so `plan.changesByResource` never has anything left to
    // route to it while the flag is off); and `db.ssl_enforcement`, gated on
    // simple presence (`pushResourceEnabled`'s
    // `local.db?.ssl_enforcement !== undefined` case) rather than a decoded
    // `enabled` value — the stock `supabase init` template ships this block
    // commented out, so a fresh project hits `disabled` here by default.
    // `auth` and `storage` always return `true` from
    // `pushResourceEnabled` now — their local `enabled` toggle only
    // controls a Docker service the Management API has no concept of, so
    // this branch can no longer fire for either — and a gated-on resource
    // dispatches to its own encoder/write pair.
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
          // MFA addon cost filter runs before anything about auth is
          // printed: a declined paid addon carries an explicit disable when
          // the remote currently has it on, or is simply dropped otherwise
          // (`applyMfaAddonDecline`, D12).
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
          // No registry-comparable path backs this write, but the summary's property
          // count (and a JSON consumer inspecting `changes`) must still see it (finding 5).
          changes: [["experimental", "webhooks", "enabled"]],
        });
      } else {
        services.push({ service: "experimental.webhooks", status: "skipped", changes: [] });
      }
    }

    // 12. Notes (stderr, after the resource loop) — declared properties with
    // no API field, declared-but-unencodable properties, declared-but-
    // unmanaged properties (count only, excluding a gated-off resource's own
    // entries), forced companion defaults, empty/unresolved credentials, and
    // the hands-off remote-only count.
    const unmanagedCount = changeSet.unmanaged.filter((changePath) => {
      const resourceForPath = pushResourceForPath(changePath);
      return resourceForPath === "unsupported" || resourceEnabled[resourceForPath];
    }).length;
    // An `unavailable` auth resource never read (or wrote) any credential —
    // the "not pushed" framing this note carries is specific to a credential
    // whose OWN value was empty/unresolved, which doesn't apply when the
    // whole resource was never compared to begin with.
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
