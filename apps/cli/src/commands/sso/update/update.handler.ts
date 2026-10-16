import { operationDefinitions, type SupabaseApiError } from "@supabase/api/effect";
import { Effect, Option, Predicate, type Redacted, Schema, Stdio, type Types } from "effect";
import * as HttpClientResponse from "effect/http/HttpClientResponse";

import { CommandPlatformApi } from "../../../auth/command-platform-api.service.ts";
import { CommandSettings } from "../../../config/command-settings.service.ts";
import { ProjectRefResolver } from "../../../config/project-ref.service.ts";
import { OutputFlag } from "../../../command-internal/global-flags.ts";
import { requireHostedMutationConsent } from "../../../command-internal/hosted-consent/hosted-consent.ts";
import {
  mutuallyExclusiveFlagsMessage,
  PERSISTENT_VALUE_FLAG_NAMES,
  PERSISTENT_VALUE_FLAG_SHORTHANDS,
  scanArgvFlags,
} from "../../../shared/cli/flag-groups.ts";
import { Output } from "../../../shared/output/output.service.ts";
import type { OutputTask } from "../../../shared/output/output.service.ts";
import { encodeSortedJson } from "../../../command-internal/output.encoders.ts";
import {
  encodeStructToml,
  encodeStructYaml,
} from "../../../command-internal/struct-output.encoders.ts";
import { SSO_PROVIDER_RESPONSE_SHAPE } from "../sso.response-shape.ts";
import { mapHttpError } from "../../../command-internal/http-errors.ts";
import { accessTokenForProfile } from "../../../auth/command-credentials.layer.ts";
import { missingAccessTokenMessage } from "../../../auth/access-token.ts";
import { LinkedProjectCache } from "../../../telemetry/linked-project-cache.service.ts";
import { TelemetryState } from "../../../telemetry/telemetry-state.service.ts";
import { gateResponse, suggestUpgrade } from "../../../command-internal/upgrade-suggest.ts";
import {
  argvBoolValue,
  argvEnumValue,
  argvSliceValue,
  argvStringValue,
  resolveArgvProfile,
  validateArgvWorkdir,
} from "../../../command-internal/argv-flag-reconcile.ts";
import {
  SsoFlagNeedsArgumentError,
  SsoInvalidFlagValueError,
  SsoMutexFlagError,
  SsoUpdateArityError,
  SsoUpdateAttributeMappingFileError,
  SsoUpdateMetadataFileError,
  SsoUpdateNetworkError,
  SsoUpdateNotFoundError,
  SsoUpdateUnexpectedStatusError,
  SsoAccessTokenError,
  SsoTomlEncodeError,
} from "../sso.errors.ts";
import { quoteSsoString, renderSingleProvider, validateUuid } from "../sso.format.ts";
import { validateMetadataUrl } from "../sso.metadata-url.ts";
import {
  SSO_NAME_ID_FORMATS,
  readAttributeMappingFile,
  readMetadataFile,
  toNameIdFormat,
} from "../sso.saml.ts";
import type { SsoUpdateFlags } from "./update.command.ts";

const readMetadata = readMetadataFile({
  openError: (args) => new SsoUpdateMetadataFileError(args),
  nonUtf8Error: (args) =>
    new SsoUpdateMetadataFileError({ message: args.message, reason: "invalid_content" }),
});

const readAttributeMapping = readAttributeMappingFile({
  openError: (args) => new SsoUpdateAttributeMappingFileError(args),
});

type SsoUpdateBody = Types.Mutable<
  Omit<
    Schema.Schema.Type<typeof operationDefinitions.v1UpdateASsoProvider.inputSchema>,
    "ref" | "provider_id"
  >
>;

const decodeProvider = Schema.decodeUnknownEffect(
  operationDefinitions.v1UpdateASsoProvider.outputSchema,
);

const mapGetStatusOrNetwork = mapHttpError({
  networkError: SsoUpdateNetworkError,
  statusError: SsoUpdateUnexpectedStatusError,
  networkMessage: (cause) => `failed to get sso provider: ${cause}`,
  statusMessage: (_status, body) => `unexpected error fetching identity provider: ${body}`,
});

const mapPutStatusOrNetwork = mapHttpError({
  networkError: SsoUpdateNetworkError,
  statusError: SsoUpdateUnexpectedStatusError,
  networkMessage: (cause) => `failed to update sso provider: ${cause}`,
  // Go reuses the GET error message for the PUT.
  statusMessage: (_status, body) => `unexpected error fetching identity provider: ${body}`,
});

const SSO_UPDATE_COMMAND_PATH = ["sso", "update"] as const;

/**
 * Three independent mutex groups (not one 3-way group covering `--domains`).
 * Checked in alphabetical order of the joined group key, which matches
 * declaration order here.
 */
const SSO_UPDATE_MUTEX_GROUPS = [
  ["domains", "add-domains"],
  ["domains", "remove-domains"],
  ["metadata-file", "metadata-url"],
] as const;

/**
 * Value-taking flags for `scanArgvFlags`: each consumes the next argv token
 * as its value. `--skip-url-validation` is this command's only boolean flag,
 * so it's excluded; `sso update` declares no shorthands beyond the
 * persistent `-o`.
 */
const SSO_UPDATE_SCAN_SPEC = {
  valueFlagNames: new Set([
    "project-ref",
    "domains",
    "add-domains",
    "remove-domains",
    "metadata-file",
    "metadata-url",
    "attribute-mapping-file",
    "name-id-format",
    ...PERSISTENT_VALUE_FLAG_NAMES,
  ]),
  valueFlagShorthands: PERSISTENT_VALUE_FLAG_SHORTHANDS,
} as const;

type TokenForAux<R> = Effect.Effect<Option.Option<Redacted.Redacted<string>> | undefined, never, R>;

interface GateContext<R> {
  readonly ref: string;
  readonly apiUrl: string;
  readonly tokenForAux: TokenForAux<R>;
}

const suggestUpgradeFor = <R>(gate: GateContext<R>, cause: SupabaseApiError, statusCode: number) =>
  Effect.gen(function* () {
    const token = yield* gate.tokenForAux;
    return yield* suggestUpgrade({
      projectRef: gate.ref,
      featureKey: "auth.saml_2",
      statusCode,
      response: gateResponse(cause),
      apiUrl: gate.apiUrl,
      ...(token !== undefined ? { accessToken: token } : {}),
    });
  });

const handleGetError = <R>(gate: GateContext<R>, providerId: string, cause: SupabaseApiError) =>
  mapGetStatusOrNetwork(cause).pipe(
    Effect.catchTag("SsoUpdateUnexpectedStatusError", (mapped) =>
      Effect.gen(function* () {
        const upgradeSuggested = yield* suggestUpgradeFor(gate, cause, mapped.status);
        if (mapped.status === 404) {
          return yield* new SsoUpdateNotFoundError({
            message: `An identity provider with ID ${quoteSsoString(providerId)} could not be found.`,
            upgradeSuggested,
          });
        }
        return yield* new SsoUpdateUnexpectedStatusError({
          status: mapped.status,
          body: mapped.body,
          message: mapped.message,
          upgradeSuggested,
        });
      }),
    ),
  );

const handlePutError = <R>(gate: GateContext<R>, cause: SupabaseApiError) =>
  mapPutStatusOrNetwork(cause).pipe(
    Effect.catchTag("SsoUpdateUnexpectedStatusError", (mapped) =>
      Effect.gen(function* () {
        const upgradeSuggested = yield* suggestUpgradeFor(gate, cause, mapped.status);
        return yield* new SsoUpdateUnexpectedStatusError({
          status: mapped.status,
          body: mapped.body,
          message: mapped.message,
          upgradeSuggested,
        });
      }),
    ),
  );

interface ExistingDomainItem {
  readonly domain?: string;
}

function mergeDomains(
  existing: ReadonlyArray<ExistingDomainItem> | undefined,
  add: ReadonlyArray<string>,
  remove: ReadonlyArray<string>,
): ReadonlyArray<string> {
  // Uses a Set, so iteration order is unspecified; integration tests sort
  // before asserting. The seed check is nil-ness only, so an empty-string
  // domain from the GET response is kept, not filtered.
  const set = new Set<string>();
  if (existing !== undefined) {
    for (const item of existing) {
      if (typeof item.domain === "string") {
        set.add(item.domain);
      }
    }
  }
  for (const removeDomain of remove) set.delete(removeDomain);
  for (const addDomain of add) set.add(addDomain);
  return Array.from(set);
}

export const ssoUpdate = Effect.fn("sso.update")(function* (flags: SsoUpdateFlags) {
  const output = yield* Output;
  const outputFlag = yield* OutputFlag;
  const api = yield* CommandPlatformApi;
  const cliSettings = yield* CommandSettings;
  const resolver = yield* ProjectRefResolver;
  const linkedProjectCache = yield* LinkedProjectCache;
  const telemetryState = yield* TelemetryState;
  const stdio = yield* Stdio.Stdio;
  const rawArgs = yield* stdio.args;

  yield* Effect.gen(function* () {
    // Precedence: arity validation, then mutex, then the handler body (which
    // validates the provider ID). Keep this block ahead of `validateUuid`
    // below.
    //
    // "Set" means passed at all, not the resulting value — `--domains=`
    // parses to `[]` but must still count as set, so gating on
    // `.length > 0` would miss it.
    const scan = scanArgvFlags(rawArgs, SSO_UPDATE_COMMAND_PATH, SSO_UPDATE_SCAN_SPEC);
    const occurrences = scan.occurrences;

    // Validate against the accepted values before the missing-value,
    // arity, and mutex checks — the first invalid occurrence fails
    // even if a later one overrides it, and bool parsing excludes
    // `yes`/`no`.
    const skipUrlValidation = yield* Effect.fromResult(
      argvBoolValue(occurrences, "skip-url-validation"),
    ).pipe(Effect.mapError((message) => new SsoInvalidFlagValueError({ message })));
    const nameIdFormat = yield* Effect.fromResult(
      argvEnumValue(occurrences, "name-id-format", SSO_NAME_ID_FORMATS),
    ).pipe(Effect.mapError((message) => new SsoInvalidFlagValueError({ message })));

    // A bare value-taking flag as the final token is a parse error,
    // reported even when the arg count is also wrong. The TS parser accepts
    // it as unset, so this must run before the arity check.
    if (scan.missingValueError !== undefined) {
      return yield* new SsoFlagNeedsArgumentError({ message: scan.missingValueError });
    }

    // Arity is counted from the scanned positionals, which shift
    // whenever a flag token was consumed as another flag's value — the TS
    // parser's own arity check can't see that. Gated on `anchored`: an
    // unscoped scan has no positional information.
    if (scan.anchored && scan.positionals.length !== 1) {
      return yield* new SsoUpdateArityError({
        message: `accepts 1 arg(s), received ${scan.positionals.length}`,
      });
    }

    // Reconcile the effective `--profile` before the workdir check: an
    // unloadable profile loses to an arity violation but beats the workdir
    // and mutex checks. Where the scan and parser agree this resolves to
    // `none` and the config layer's apiUrl is already correct.
    const reconciledProfile = yield* resolveArgvProfile(scan);
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

    // Validate the effective `--workdir` after arity but before the mutex
    // checks: it loses to an arity violation but beats a mutex violation and
    // any GET/PUT.
    yield* validateArgvWorkdir(scan);

    for (const group of SSO_UPDATE_MUTEX_GROUPS) {
      const changed = group.filter((flagName) => occurrences.has(flagName));
      if (changed.length > 1) {
        return yield* new SsoMutexFlagError({
          message: mutuallyExclusiveFlagsMessage(group, changed),
        });
      }
    }

    // Everything below reads values from the scan rather
    // than the TS-parsed flags — see `add.handler.ts` and `argv-flag-reconcile.ts`.
    const projectRefFlag = argvStringValue(occurrences, "project-ref");
    const metadataFile = argvStringValue(occurrences, "metadata-file");
    const metadataUrl = argvStringValue(occurrences, "metadata-url");
    const attributeMappingFile = argvStringValue(occurrences, "attribute-mapping-file");
    const domains = argvSliceValue(occurrences, "domains", flags.domains);
    const addDomains = argvSliceValue(occurrences, "add-domains", flags.addDomains);
    const removeDomains = argvSliceValue(occurrences, "remove-domains", flags.removeDomains);

    const providerId = yield* Effect.fromResult(validateUuid(flags.providerId));

    const ref = yield* resolver.resolve(projectRefFlag);

    // Use the argv-reconciled profile's host when it disagreed with
    // `--profile`, otherwise the config layer's.
    const apiUrl = Option.getOrElse(profileApiUrl, () => cliSettings.apiUrl);

    yield* Effect.annotateCurrentSpan({
      "sso.metadata_source": Option.isSome(metadataFile)
        ? "file"
        : Option.isSome(metadataUrl)
          ? "url"
          : "none",
      "sso.domain_count": domains.length + addDomains.length + removeDomains.length,
    });

    yield* Effect.gen(function* () {
      const reconciledToken =
        reconciledTokenCached === undefined
          ? undefined
          : (yield* Effect.filterOrFail(
              reconciledTokenCached,
              Option.isSome,
              () => new SsoAccessTokenError({ message: missingAccessTokenMessage() }),
            )).value;
      const requestOptions =
        reconciledToken === undefined
          ? undefined
          : { baseUrl: apiUrl, accessToken: reconciledToken };
      const gate = { ref, apiUrl, tokenForAux: reconciledTokenForAux };

      const startTask = Effect.suspend((): Effect.Effect<OutputTask | undefined> =>
        output.format === "text" ? output.task("Updating SSO provider...") : Effect.undefined,
      );
      const fetching = yield* startTask;

      // Always GETs first, regardless of which flags are set.
      const existing = yield* api.v1
        .getASsoProvider({ ref, provider_id: providerId }, requestOptions)
        .pipe(
          Effect.tapError(() => fetching?.fail() ?? Effect.void),
          Effect.catch((cause) => handleGetError(gate, providerId, cause)),
        );

      const body: SsoUpdateBody = {};

      if (Option.isSome(metadataFile)) {
        const xml = yield* readMetadata(metadataFile.value);
        body.metadata_xml = xml;
      } else if (Option.isSome(metadataUrl)) {
        if (!skipUrlValidation) {
          yield* validateMetadataUrl(metadataUrl.value).pipe(
            // Trailing period here, unlike `sso add`'s version of this message.
            Effect.mapError(
              (cause) =>
                new SsoUpdateMetadataFileError({
                  message: `${cause.message} Use --skip-url-validation to suppress this error.`,
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

      // `domains` is always recomputed and sent, even when no domain flag
      // was passed; an empty merged set serializes as `"domains":[]`, never omitted.
      const finalDomains =
        domains.length > 0
          ? [...domains]
          : mergeDomains(existing.domains, addDomains, removeDomains);
      body.domains = [...finalDomains];

      if (Option.isSome(nameIdFormat)) {
        const format = toNameIdFormat(nameIdFormat.value);
        if (format !== undefined) body.name_id_format = format;
      }

      yield* fetching?.clear ?? Effect.void;
      yield* requireHostedMutationConsent({
        action: `Update SSO provider ${providerId}`,
        details: [
          ...(Option.isSome(metadataFile) ? ["Metadata: from a file"] : []),
          ...(Option.isSome(metadataUrl) ? ["Metadata: from a URL"] : []),
          ...(Option.isSome(attributeMappingFile) ? ["Attribute mapping: replaced"] : []),
          ...(Option.isSome(nameIdFormat) ? [`Name ID format: ${nameIdFormat.value}`] : []),
          `Domains: ${finalDomains.join(", ") || "(none)"}`,
        ],
      });
      const updating = yield* startTask;

      // `executeRaw` keeps the response body intact so structured output emits it as the API
      // returned it; the typed schema decodes a copy for the table view.
      const { rawBody, provider } = yield* Effect.gen(function* () {
        const response = yield* api
          .executeRaw(
            operationDefinitions.v1UpdateASsoProvider,
            { ref, provider_id: providerId, ...body },
            { ...requestOptions, retry: { requestTimeoutMs: Number.POSITIVE_INFINITY } },
          )
          .pipe(Effect.flatMap(HttpClientResponse.filterStatusOk));
        const rawBody: unknown = yield* response.json;
        return { rawBody, provider: yield* decodeProvider(rawBody) };
      }).pipe(
        Effect.catch((cause) => handlePutError(gate, cause)),
        Effect.tapError(() => updating?.fail() ?? Effect.void),
      );
      yield* updating?.clear ?? Effect.void;

      const outputFlagFormat = Option.getOrUndefined(outputFlag);

      if (outputFlagFormat === "json") {
        yield* output.raw(encodeSortedJson(rawBody));
        return;
      }
      if (outputFlagFormat === "yaml") {
        yield* output.raw(encodeStructYaml(rawBody, SSO_PROVIDER_RESPONSE_SHAPE));
        return;
      }
      if (outputFlagFormat === "toml") {
        // Same TOML-encode-failure pattern as list/show.
        const toml = yield* Effect.try({
          try: () => encodeStructToml(rawBody, SSO_PROVIDER_RESPONSE_SHAPE),
          catch: (cause) =>
            new SsoTomlEncodeError({
              message: `failed to output toml: ${cause instanceof Error ? cause.message : String(cause)}`,
            }),
        });
        yield* output.raw(toml);
        return;
      }
      if (outputFlagFormat === "env") {
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
