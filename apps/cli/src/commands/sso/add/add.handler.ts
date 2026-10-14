import { operationDefinitions, type SupabaseApiError } from "@supabase/api/effect";
import { Effect, Option, Predicate, type Redacted, Schema, Stdio, type Types } from "effect";
import * as HttpClientResponse from "effect/http/HttpClientResponse";

import { CommandPlatformApi } from "../../../auth/command-platform-api.service.ts";
import { CommandSettings } from "../../../config/command-settings.service.ts";
import { ProjectRefResolver } from "../../../config/project-ref.service.ts";
import { OutputFlag } from "../../../command-internal/global-flags.ts";
import {
  cobraMutuallyExclusiveErrorMessage,
  PERSISTENT_VALUE_FLAG_NAMES,
  PERSISTENT_VALUE_FLAG_SHORTHANDS,
  pflagArgvScan,
} from "../../../shared/cli/cobra-flag-groups.ts";
import { Output } from "../../../shared/output/output.service.ts";
import { encodeGoJson } from "../../../command-internal/go-output.encoders.ts";
import { encodeGoToml, encodeGoYaml } from "../../../command-internal/go-struct-output.encoders.ts";
import { GO_SSO_PROVIDER_RESPONSE } from "../sso.go-payload.ts";
import { mapHttpError } from "../../../command-internal/http-errors.ts";
import { accessTokenForProfile } from "../../../auth/command-credentials.layer.ts";
import { missingAccessTokenMessage } from "../../../auth/access-token.ts";
import { LinkedProjectCache } from "../../../telemetry/linked-project-cache.service.ts";
import { TelemetryState } from "../../../telemetry/telemetry-state.service.ts";
import { gateResponse, suggestUpgrade } from "../../../command-internal/upgrade-suggest.ts";
import {
  pflagBoolValue,
  pflagEnumValue,
  pflagSliceValue,
  pflagStringValue,
  resolvePflagProfile,
  validatePflagWorkdir,
} from "../../../command-internal/pflag-reconcile.ts";
import {
  SsoAddAttributeMappingFileError,
  SsoAddMetadataFileError,
  SsoAddNetworkError,
  SsoAddRequiredFlagError,
  SsoAddSamlDisabledError,
  SsoAddUnexpectedStatusError,
  SsoFlagNeedsArgumentError,
  SsoInvalidFlagValueError,
  SsoMutexFlagError,
  SsoAccessTokenError,
  SsoTomlEncodeError,
} from "../sso.errors.ts";
import { renderSingleProvider } from "../sso.format.ts";
import { validateMetadataUrl } from "../sso.metadata-url.ts";
import {
  SSO_NAME_ID_FORMATS,
  readAttributeMappingFile,
  readMetadataFile,
  toNameIdFormat,
} from "../sso.saml.ts";
import type { SsoAddFlags } from "./add.command.ts";

const SAML_DISABLED_MESSAGE =
  "SAML 2.0 support is not enabled for this project. Please enable it through the dashboard";

type SsoAddBody = Types.Mutable<
  Omit<Schema.Schema.Type<typeof operationDefinitions.v1CreateASsoProvider.inputSchema>, "ref">
>;

const decodeProvider = Schema.decodeUnknownEffect(
  operationDefinitions.v1CreateASsoProvider.outputSchema,
);

const mapStatusOrNetwork = mapHttpError({
  networkError: SsoAddNetworkError,
  statusError: SsoAddUnexpectedStatusError,
  networkMessage: (cause) => `failed to create sso provider: ${cause}`,
  statusMessage: (_status, body) => `Unexpected error adding identity provider: ${body}`,
});

const readMetadata = readMetadataFile({
  openError: (args) => new SsoAddMetadataFileError(args),
  nonUtf8Error: (args) =>
    new SsoAddMetadataFileError({ message: args.message, reason: "invalid_content" }),
});

const readAttributeMapping = readAttributeMappingFile({
  openError: (args) => new SsoAddAttributeMappingFileError(args),
});

type TokenForAux<R> = Effect.Effect<Option.Option<Redacted.Redacted<string>> | undefined, never, R>;

const handleAddError = <R>(
  ref: string,
  apiUrl: string,
  tokenForAux: TokenForAux<R>,
  cause: SupabaseApiError,
) =>
  mapStatusOrNetwork(cause).pipe(
    Effect.catchTag("SsoAddUnexpectedStatusError", (mapped) =>
      Effect.gen(function* () {
        const upgradeSuggested = yield* suggestUpgrade({
          projectRef: ref,
          featureKey: "auth.saml_2",
          statusCode: mapped.status,
          response: gateResponse(cause),
          apiUrl,
          ...(yield* Effect.map(tokenForAux, (token) =>
            token !== undefined ? { accessToken: token } : {},
          )),
        });
        if (mapped.status === 404) {
          return yield* new SsoAddSamlDisabledError({
            message: SAML_DISABLED_MESSAGE,
            upgradeSuggested,
          });
        }
        return yield* new SsoAddUnexpectedStatusError({
          status: mapped.status,
          body: mapped.body,
          message: mapped.message,
          upgradeSuggested,
        });
      }),
    ),
  );

const SSO_ADD_COMMAND_PATH = ["sso", "add"] as const;

// Declaration order sets the mutex error message's bracket order.
const SSO_ADD_MUTEX_GROUP = ["metadata-file", "metadata-url"] as const;

// Value-taking flags for `pflagArgvScan`: each consumes the next argv token
// as its value. `--skip-url-validation` is this command's only boolean flag,
// so it's excluded.
const SSO_ADD_SCAN_SPEC = {
  valueFlagNames: new Set([
    "project-ref",
    "type",
    "domains",
    "metadata-file",
    "metadata-url",
    "attribute-mapping-file",
    "name-id-format",
    ...PERSISTENT_VALUE_FLAG_NAMES,
  ]),
  valueFlagShorthands: new Map([["t", "type"], ...PERSISTENT_VALUE_FLAG_SHORTHANDS]),
} as const;

export const ssoAdd = Effect.fn("sso.add")(function* (flags: SsoAddFlags) {
  const output = yield* Output;
  const goOutputFlag = yield* OutputFlag;
  const api = yield* CommandPlatformApi;
  const cliSettings = yield* CommandSettings;
  const resolver = yield* ProjectRefResolver;
  const linkedProjectCache = yield* LinkedProjectCache;
  const telemetryState = yield* TelemetryState;
  const stdio = yield* Stdio.Stdio;
  const rawArgs = yield* stdio.args;

  yield* Effect.gen(function* () {
    // Required-flag and mutex validation run first, against raw argv rather
    // than the parsed flags: pflag treats a flag as "set" once passed
    // regardless of value, and consumes tokens differently than the TS
    // parser does.
    const scan = pflagArgvScan(rawArgs, SSO_ADD_COMMAND_PATH, SSO_ADD_SCAN_SPEC);
    const occurrences = scan.occurrences;

    // Validate against pflag's accepted values before the missing-value,
    // required-flag, and mutex checks — pflag fails on the first invalid
    // occurrence even if a later one overrides it, and its bool parsing
    // excludes `yes`/`no`.
    yield* Effect.fromResult(pflagEnumValue(occurrences, "type", ["saml"], "-t, --type")).pipe(
      Effect.mapError((message) => new SsoInvalidFlagValueError({ message })),
    );
    const skipUrlValidation = yield* Effect.fromResult(
      pflagBoolValue(occurrences, "skip-url-validation"),
    ).pipe(Effect.mapError((message) => new SsoInvalidFlagValueError({ message })));
    const nameIdFormat = yield* Effect.fromResult(
      pflagEnumValue(occurrences, "name-id-format", SSO_NAME_ID_FORMATS),
    ).pipe(Effect.mapError((message) => new SsoInvalidFlagValueError({ message })));

    // A bare value-taking flag as the final token (e.g. `--domains` with
    // nothing after) is a pflag parse error; the TS parser accepts it as
    // unset, so this must run before every other validation.
    if (scan.missingValueError !== undefined) {
      return yield* new SsoFlagNeedsArgumentError({ message: scan.missingValueError });
    }

    // Reconcile the effective `--profile` before the workdir check: when the
    // scan and the TS parser disagree on which token `--profile` consumed,
    // the reconciled profile decides the API host, not the parser's. Where
    // they agree this resolves to `none` and the config layer's apiUrl is
    // already correct.
    const reconciledProfile = yield* resolvePflagProfile(scan);
    const profileApiUrl = Option.map(reconciledProfile, (profile) => profile.apiUrl);
    // Resolved once (memoized) so the token read happens after
    // required/mutex/workdir validation — a missing or invalid reconciled
    // token must not preempt those errors. Auxiliary calls (cache fill,
    // upgrade-gate GETs) use the failure-absorbing variant below instead.
    const reconciledTokenCached = Option.isSome(reconciledProfile)
      ? yield* Effect.cached(accessTokenForProfile(reconciledProfile.value.name))
      : undefined;
    const reconciledTokenForAux =
      reconciledTokenCached === undefined
        ? Effect.as(Effect.void, undefined)
        : Effect.orElseSucceed(reconciledTokenCached, () =>
            Option.none<Redacted.Redacted<string>>(),
          );

    // Validate the effective `--workdir` before the required-type and mutex
    // checks: when the scan and the parser disagree on what `--workdir`
    // consumed, this stops a POST that would otherwise fire against the
    // wrong metadata source.
    yield* validatePflagWorkdir(scan);

    // `--type` is required. If pflag would have consumed the `--type`/`-t`
    // token as another flag's value rather than registering it, the
    // required-flag check must still fail — the TS parser can't see that
    // (it refuses flag-shaped values), so this reproduces it from the scan.
    if (!occurrences.has("type") && scan.consumedFlagNames.has("type")) {
      return yield* new SsoAddRequiredFlagError({ message: `required flag(s) "type" not set` });
    }

    const changed = SSO_ADD_MUTEX_GROUP.filter((flagName) => occurrences.has(flagName));
    if (changed.length > 1) {
      return yield* new SsoMutexFlagError({
        message: cobraMutuallyExclusiveErrorMessage(SSO_ADD_MUTEX_GROUP, changed),
      });
    }

    // Everything below reads pflag-effective values from the scan rather
    // than the TS-parsed flags, since pflag consumes flag-shaped tokens as
    // values where the parser doesn't.
    const projectRef = pflagStringValue(occurrences, "project-ref");
    const metadataFile = pflagStringValue(occurrences, "metadata-file");
    const metadataUrl = pflagStringValue(occurrences, "metadata-url");
    const attributeMappingFile = pflagStringValue(occurrences, "attribute-mapping-file");
    const domains = pflagSliceValue(occurrences, "domains", flags.domains);

    const ref = yield* resolver.resolve(projectRef);

    // Use the pflag-reconciled profile's host when it disagreed with
    // `--profile`, otherwise the config layer's — applies to the POST and
    // every auxiliary call alike.
    const apiUrl = Option.getOrElse(profileApiUrl, () => cliSettings.apiUrl);

    yield* Effect.annotateCurrentSpan({
      "sso.metadata_source": Option.isSome(metadataFile)
        ? "file"
        : Option.isSome(metadataUrl)
          ? "url"
          : "none",
      "sso.domain_count": domains.length,
    });

    yield* Effect.gen(function* () {
      const body: SsoAddBody = {
        type: "saml",
      };

      if (Option.isSome(metadataFile)) {
        const xml = yield* readMetadata(metadataFile.value);
        body.metadata_xml = xml;
      } else if (Option.isSome(metadataUrl)) {
        if (!skipUrlValidation) {
          yield* validateMetadataUrl(metadataUrl.value).pipe(
            // No trailing period on this suffix, unlike `update`'s.
            Effect.mapError(
              (cause) =>
                new SsoAddMetadataFileError({
                  message: `${cause.message} Use --skip-url-validation to suppress this error`,
                  reason: "invalid_url",
                }),
            ),
          );
        }
        body.metadata_url = metadataUrl.value;
      }

      if (Option.isSome(attributeMappingFile)) {
        const mapping = yield* readAttributeMapping(attributeMappingFile.value);
        body.attribute_mapping = mapping;
      }

      if (domains.length > 0) {
        body.domains = [...domains];
      }

      if (Option.isSome(nameIdFormat)) {
        const format = toNameIdFormat(nameIdFormat.value);
        if (format !== undefined) body.name_id_format = format;
      }

      const reconciledToken =
        reconciledTokenCached === undefined
          ? undefined
          : (yield* Effect.filterOrFail(
              reconciledTokenCached,
              Option.isSome,
              () => new SsoAccessTokenError({ message: missingAccessTokenMessage() }),
            )).value;

      const creating =
        output.format === "text" ? yield* output.task("Adding SSO provider...") : undefined;

      // `executeRaw` keeps the response body intact so structured output emits it as the API
      // returned it; the typed schema decodes a copy for the table view.
      const { rawBody, provider } = yield* Effect.gen(function* () {
        const response = yield* api
          .executeRaw(
            operationDefinitions.v1CreateASsoProvider,
            { ref, ...body },
            {
              retry: { requestTimeoutMs: Number.POSITIVE_INFINITY },
              ...(reconciledToken === undefined
                ? {}
                : { baseUrl: apiUrl, accessToken: reconciledToken }),
            },
          )
          .pipe(Effect.flatMap(HttpClientResponse.filterStatusOk));
        const rawBody: unknown = yield* response.json;
        return { rawBody, provider: yield* decodeProvider(rawBody) };
      }).pipe(
        Effect.catch((cause) => handleAddError(ref, apiUrl, reconciledTokenForAux, cause)),
        Effect.tapError(() => creating?.fail() ?? Effect.void),
      );
      yield* creating?.clear ?? Effect.void;

      const goFmt = Option.getOrUndefined(goOutputFlag);

      if (goFmt === "json") {
        yield* output.raw(encodeGoJson(rawBody));
        return;
      }
      if (goFmt === "yaml") {
        yield* output.raw(encodeGoYaml(rawBody, GO_SSO_PROVIDER_RESPONSE));
        return;
      }
      if (goFmt === "toml") {
        // Same TOML-encode-failure pattern as list/show.
        const toml = yield* Effect.try({
          try: () => encodeGoToml(rawBody, GO_SSO_PROVIDER_RESPONSE),
          catch: (cause) =>
            new SsoTomlEncodeError({
              message: `failed to output toml: ${cause instanceof Error ? cause.message : String(cause)}`,
            }),
        });
        yield* output.raw(toml);
        return;
      }
      if (goFmt === "env") {
        // `-o env` emits nothing for `sso add`.
        return;
      }

      if (output.format === "json" || output.format === "stream-json") {
        yield* output.success(
          "",
          Predicate.isObjectOrArray(rawBody) ? { ...rawBody } : { value: rawBody },
        );
        return;
      }

      yield* output.raw(renderSingleProvider(provider));
    }).pipe(
      // Linked-project cache fill GETs `/v1/projects/{ref}` through the
      // reconciled host, never the config layer's.
      Effect.ensuring(
        // Resolved inside `ensuring` so the memoized token read doesn't run
        // before the handler body.
        Effect.flatMap(reconciledTokenForAux, (token) =>
          linkedProjectCache.cache(ref, undefined, Option.getOrUndefined(profileApiUrl), token),
        ),
      ),
    );
  }).pipe(Effect.ensuring(telemetryState.flush));
});
