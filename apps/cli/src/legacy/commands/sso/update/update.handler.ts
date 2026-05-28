import type { SupabaseApiError } from "@supabase/api/effect";
import { Effect, Option, Result } from "effect";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";

import { LegacyPlatformApi } from "../../../auth/legacy-platform-api.service.ts";
import { LegacyCliConfig } from "../../../config/legacy-cli-config.service.ts";
import { LegacyProjectRefResolver } from "../../../config/legacy-project-ref.service.ts";
import { LegacyOutputFlag } from "../../../../shared/legacy/global-flags.ts";
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
import { suggestUpgradeOnError } from "../../../telemetry/legacy-upgrade-suggested.ts";
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

const handleGetError = (ref: string, providerId: string, cause: SupabaseApiError) =>
  Effect.gen(function* () {
    const mapped = yield* Effect.flip(mapGetStatusOrNetwork(cause));
    if (mapped._tag === "LegacySsoUpdateUnexpectedStatusError") {
      yield* suggestUpgradeOnError(ref, "auth.saml_2", mapped.status);
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

  yield* Effect.gen(function* () {
    const providerId = yield* validateUuid(flags.providerId).pipe(
      Result.match({ onFailure: Effect.fail, onSuccess: Effect.succeed }),
    );

    if (flags.domains.length > 0 && flags.addDomains.length > 0) {
      return yield* Effect.fail(
        new LegacySsoMutexFlagError({
          message: "only one of --domains or --add-domains may be set",
        }),
      );
    }
    if (flags.domains.length > 0 && flags.removeDomains.length > 0) {
      return yield* Effect.fail(
        new LegacySsoMutexFlagError({
          message: "only one of --domains or --remove-domains may be set",
        }),
      );
    }
    if (Option.isSome(flags.metadataFile) && Option.isSome(flags.metadataUrl)) {
      return yield* Effect.fail(
        new LegacySsoMutexFlagError({
          message: "only one of --metadata-file or --metadata-url may be set",
        }),
      );
    }

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
        yield* suggestUpgradeOnError(ref, "auth.saml_2", response.status);
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
