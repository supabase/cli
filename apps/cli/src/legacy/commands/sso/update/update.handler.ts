import type { SupabaseApiError } from "@supabase/api/effect";
import { Effect, Option, Result, Stdio } from "effect";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";

import { LegacyPlatformApi } from "../../../auth/legacy-platform-api.service.ts";
import { LegacyCliConfig } from "../../../config/legacy-cli-config.service.ts";
import { LegacyProjectRefResolver } from "../../../config/legacy-project-ref.service.ts";
import { LegacyOutputFlag } from "../../../../shared/legacy/global-flags.ts";
import {
  cobraMutuallyExclusiveErrorMessage,
  hasExplicitValueFlag,
} from "../../../../shared/cli/cobra-flag-groups.ts";
import { Output } from "../../../../shared/output/output.service.ts";
import {
  encodeGoJson,
  encodeGoStructJsonBody,
  encodeToml,
  encodeYaml,
} from "../../../shared/legacy-go-output.encoders.ts";
import { mapLegacyHttpError, sanitizeLegacyErrorBody } from "../../../shared/legacy-http-errors.ts";
import { resolveLegacyAccessToken } from "../../../shared/legacy-resolve-token.ts";
import { LegacyLinkedProjectCache } from "../../../telemetry/legacy-linked-project-cache.service.ts";
import { LegacyTelemetryState } from "../../../telemetry/legacy-telemetry-state.service.ts";
import { legacySuggestUpgrade } from "../../../shared/legacy-upgrade-suggest.ts";
import {
  LegacySsoMutexFlagError,
  LegacySsoUpdateAttributeMappingFileError,
  LegacySsoUpdateMetadataFileError,
  LegacySsoUpdateNetworkError,
  LegacySsoUpdateNotFoundError,
  LegacySsoUpdateUnexpectedStatusError,
} from "../sso.errors.ts";
import { renderSingleProvider, toLegacySsoProviderView, validateUuid } from "../sso.format.ts";
import { validateMetadataUrl } from "../sso.metadata-url.ts";
import { readAttributeMappingFile, readMetadataFile } from "../sso.saml.ts";
import type { LegacySsoUpdateFlags } from "./update.command.ts";

const readMetadata = readMetadataFile({
  openError: (args) => new LegacySsoUpdateMetadataFileError(args),
  nonUtf8Error: (args) => new LegacySsoUpdateMetadataFileError({ message: args.message }),
});

const readAttributeMapping = readAttributeMappingFile({
  openError: (args) => new LegacySsoUpdateAttributeMappingFileError(args),
});

const mapGetStatusOrNetwork = mapLegacyHttpError({
  networkError: LegacySsoUpdateNetworkError,
  statusError: LegacySsoUpdateUnexpectedStatusError,
  networkMessage: (cause) => `failed to get sso provider: ${cause}`,
  statusMessage: (_status, body) => `unexpected error fetching identity provider: ${body}`,
});

const SSO_UPDATE_COMMAND_PATH = ["sso", "update"] as const;

/**
 * Registration order mirrors Go's `cmd/sso.go:178-180` — three independent
 * `MarkFlagsMutuallyExclusive` groups (`metadata-file`/`metadata-url` plus two
 * 2-element groups sharing `--domains`, not one 3-way group). Cobra checks
 * groups in `sort.Strings`-order of the joined group key (`flag_groups.go:189`),
 * which happens to match registration order here: "domains add-domains" <
 * "domains remove-domains" < "metadata-file metadata-url" alphabetically.
 */
const SSO_UPDATE_MUTEX_GROUPS = [
  ["domains", "add-domains"],
  ["domains", "remove-domains"],
  ["metadata-file", "metadata-url"],
] as const;

/**
 * Every value-taking (non-boolean) flag `sso update` declares
 * (`update.command.ts`) — tells `hasExplicitValueFlag` which bare tokens
 * consume the next argv token as their value. `--skip-url-validation` is this
 * command's only boolean flag and is deliberately excluded; booleans never
 * consume a following token.
 */
const SSO_UPDATE_VALUE_FLAG_NAMES = new Set([
  "project-ref",
  "domains",
  "add-domains",
  "remove-domains",
  "metadata-file",
  "metadata-url",
  "attribute-mapping-file",
  "name-id-format",
]);

const handleGetError = (ref: string, providerId: string, cause: SupabaseApiError) =>
  Effect.gen(function* () {
    const mapped = yield* Effect.flip(mapGetStatusOrNetwork(cause));
    if (mapped._tag === "LegacySsoUpdateUnexpectedStatusError") {
      yield* legacySuggestUpgrade({
        projectRef: ref,
        featureKey: "auth.saml_2",
        statusCode: mapped.status,
      });
      if (mapped.status === 404) {
        return yield* Effect.fail(
          new LegacySsoUpdateNotFoundError({
            message: `An identity provider with ID ${JSON.stringify(providerId)} could not be found.`,
          }),
        );
      }
    }
    return yield* Effect.fail(mapped);
  });

interface ExistingDomainItem {
  readonly domain?: string;
}

function mergeDomains(
  existing: ReadonlyArray<ExistingDomainItem> | undefined,
  add: ReadonlyArray<string>,
  remove: ReadonlyArray<string>,
): ReadonlyArray<string> {
  // Mirrors Go's `update.go:93-117` — seed from current domains, apply
  // removals, then add new entries. Go uses a `map[string]bool`, so iteration
  // order is unspecified; integration tests sort before asserting.
  const set = new Set<string>();
  if (existing !== undefined) {
    for (const item of existing) {
      if (typeof item.domain === "string" && item.domain.length > 0) {
        set.add(item.domain);
      }
    }
  }
  for (const removeDomain of remove) set.delete(removeDomain);
  for (const addDomain of add) set.add(addDomain);
  return Array.from(set);
}

export const legacySsoUpdate = Effect.fn("legacy.sso.update")(function* (
  flags: LegacySsoUpdateFlags,
) {
  const output = yield* Output;
  const goOutputFlag = yield* LegacyOutputFlag;
  const api = yield* LegacyPlatformApi;
  const httpClient = yield* HttpClient.HttpClient;
  const cliConfig = yield* LegacyCliConfig;
  const resolver = yield* LegacyProjectRefResolver;
  const linkedProjectCache = yield* LegacyLinkedProjectCache;
  const telemetryState = yield* LegacyTelemetryState;
  const stdio = yield* Stdio.Stdio;
  const rawArgs = yield* stdio.args;

  yield* Effect.gen(function* () {
    // cobra runs `ValidateFlagGroups` (`command.go:1010`) before `RunE`
    // (`command.go:1014`), and Go's provider-ID format check lives inside
    // `RunE` (`cmd/sso.go:90-91`) — so a mutex violation must win over an
    // invalid provider ID when both apply. Keep this block ahead of
    // `validateUuid` below to match that precedence.
    //
    // "Set" follows cobra's `pflag.Changed` — whether the flag was passed at
    // all — not the resulting value. `--domains`/`--add-domains`/
    // `--remove-domains` all default to `[]`, so `--domains=` (parses to an
    // empty array) must still count as "set"; gating on `.length > 0` would
    // miss it, the same "changed vs truthy" gap CLI-1860 fixed for
    // `functions download`'s `--use-docker`.
    //
    // `hasExplicitValueFlag` (not the simpler `hasExplicitLongFlag`) is
    // required here because every flag in these groups takes a value: a bare
    // `--metadata-file --metadata-url` is pflag consuming `--metadata-url` as
    // `metadata-file`'s (oddly named) value, not two flags being set — see
    // that function's doc comment.
    for (const group of SSO_UPDATE_MUTEX_GROUPS) {
      const changed = group.filter((flagName) =>
        hasExplicitValueFlag(
          rawArgs,
          SSO_UPDATE_COMMAND_PATH,
          SSO_UPDATE_VALUE_FLAG_NAMES,
          flagName,
        ),
      );
      if (changed.length > 1) {
        return yield* Effect.fail(
          new LegacySsoMutexFlagError({
            message: cobraMutuallyExclusiveErrorMessage(group, changed),
          }),
        );
      }
    }

    const providerId = yield* validateUuid(flags.providerId).pipe(
      Result.match({ onFailure: Effect.fail, onSuccess: Effect.succeed }),
    );

    const ref = yield* resolver.resolve(flags.projectRef);

    yield* Effect.gen(function* () {
      const fetching =
        output.format === "text" ? yield* output.task("Updating SSO provider...") : undefined;

      // Go's `update.go:42` always GETs first, regardless of which flags are set.
      const existing = yield* api.v1.getASsoProvider({ ref, provider_id: providerId }).pipe(
        Effect.tapError(() => fetching?.fail() ?? Effect.void),
        Effect.catch((cause) => handleGetError(ref, providerId, cause)),
      );

      const body: Record<string, unknown> = {};

      if (Option.isSome(flags.metadataFile)) {
        const xml = yield* readMetadata(flags.metadataFile.value);
        body["metadata_xml"] = xml;
      } else if (Option.isSome(flags.metadataUrl)) {
        if (!flags.skipUrlValidation) {
          yield* validateMetadataUrl(flags.metadataUrl.value).pipe(
            // Go's `update.go:69` wraps the cause with `%w Use --skip-url-validation to
            // suppress this error.` — note the single space between cause and `Use` and
            // the trailing period. Go's `create.go:47` uses the same format minus the
            // trailing period; `sso add` mirrors that.
            Effect.mapError(
              (cause) =>
                new LegacySsoUpdateMetadataFileError({
                  message: `${cause.message} Use --skip-url-validation to suppress this error.`,
                }),
            ),
          );
        }
        body["metadata_url"] = flags.metadataUrl.value;
      }

      if (Option.isSome(flags.attributeMappingFile)) {
        const mapping = yield* readAttributeMapping(flags.attributeMappingFile.value);
        body["attribute_mapping"] = mapping;
      }

      if (flags.domains.length > 0) {
        body["domains"] = [...flags.domains];
      } else if (flags.addDomains.length > 0 || flags.removeDomains.length > 0) {
        body["domains"] = mergeDomains(existing.domains, flags.addDomains, flags.removeDomains);
      }

      if (Option.isSome(flags.nameIdFormat)) {
        body["name_id_format"] = flags.nameIdFormat.value;
      }

      const tokenOpt = yield* resolveLegacyAccessToken;

      // See `add.handler.ts` for the rationale behind `bearerToken(Redacted)`.
      const request = HttpClientRequest.put(
        `${cliConfig.apiUrl}/v1/projects/${ref}/config/auth/sso/providers/${providerId}`,
      ).pipe(
        Option.isSome(tokenOpt) ? HttpClientRequest.bearerToken(tokenOpt.value) : (req) => req,
        HttpClientRequest.setHeader("User-Agent", cliConfig.userAgent),
        // See `add.handler.ts` — Go-struct key order required for cli-e2e parity.
        HttpClientRequest.bodyText(encodeGoStructJsonBody(body), "application/json"),
      );

      const response = yield* httpClient.execute(request).pipe(
        Effect.tapError(() => fetching?.fail() ?? Effect.void),
        Effect.mapError(
          (cause) =>
            new LegacySsoUpdateNetworkError({
              message: `failed to update sso provider: ${String(cause)}`,
            }),
        ),
      );

      if (response.status !== 200) {
        const rawBody = yield* response.text.pipe(Effect.orElseSucceed(() => ""));
        // Cap + sanitise to match `mapLegacyHttpError`'s defences — see add handler
        // for the rationale; the raw-HTTP path must not bypass these.
        const bodyText = sanitizeLegacyErrorBody(rawBody);
        yield* legacySuggestUpgrade({
          projectRef: ref,
          featureKey: "auth.saml_2",
          statusCode: response.status,
        });
        yield* fetching?.fail() ?? Effect.void;
        return yield* Effect.fail(
          // Go reuses the GET error message even for PUT (see `update.go:133`).
          new LegacySsoUpdateUnexpectedStatusError({
            status: response.status,
            body: bodyText,
            message: `unexpected error fetching identity provider: ${bodyText}`,
          }),
        );
      }

      const parsedJson = yield* response.json.pipe(Effect.orElseSucceed((): unknown => ({})));
      yield* fetching?.clear() ?? Effect.void;

      const goFmt = Option.getOrUndefined(goOutputFlag);

      if (goFmt === "json") {
        yield* output.raw(encodeGoJson(parsedJson));
        return;
      }
      if (goFmt === "yaml") {
        yield* output.raw(encodeYaml(parsedJson));
        return;
      }
      if (goFmt === "toml") {
        yield* output.raw(encodeToml(parsedJson) + "\n");
        return;
      }
      if (goFmt === "env") {
        return;
      }

      if (output.format === "json" || output.format === "stream-json") {
        yield* output.success(
          "",
          parsedJson !== null && typeof parsedJson === "object"
            ? (parsedJson as Record<string, unknown>)
            : { value: parsedJson },
        );
        return;
      }

      yield* output.raw(renderSingleProvider(toLegacySsoProviderView(parsedJson)));
    }).pipe(Effect.ensuring(linkedProjectCache.cache(ref)));
  }).pipe(Effect.ensuring(telemetryState.flush));
});
