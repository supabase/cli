import type { SupabaseApiError } from "@supabase/api/effect";
import { Effect, Option, Redacted, Result, Stdio } from "effect";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";

import { CommandPlatformApi } from "../../../auth/command-platform-api.service.ts";
import { CommandSettings } from "../../../config/command-settings.service.ts";
import { IdentityStitch } from "../../../command-internal/identity-stitch.ts";
import { ProjectRefResolver } from "../../../config/project-ref.service.ts";
import { OutputFlag } from "../../../command-internal/global-flags.ts";
import {
  cobraMutuallyExclusiveErrorMessage,
  PERSISTENT_VALUE_FLAG_NAMES,
  PERSISTENT_VALUE_FLAG_SHORTHANDS,
  pflagArgvScan,
} from "../../../shared/cli/cobra-flag-groups.ts";
import { Output } from "../../../shared/output/output.service.ts";
import {
  encodeGoJson,
  encodeGoStructJsonBody,
} from "../../../command-internal/go-output.encoders.ts";
import { encodeGoToml, encodeGoYaml } from "../../../command-internal/go-struct-output.encoders.ts";
import { GO_SSO_PROVIDER_RESPONSE } from "../sso.go-payload.ts";
import { mapHttpError, sanitizeErrorBody } from "../../../command-internal/http-errors.ts";
import { resolveAccessToken } from "../../../command-internal/resolve-token.ts";
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
import { renderSingleProvider, toSsoProviderView, validateUuid } from "../sso.format.ts";
import { validateMetadataUrl } from "../sso.metadata-url.ts";
import { SSO_NAME_ID_FORMATS, readAttributeMappingFile, readMetadataFile } from "../sso.saml.ts";
import type { SsoUpdateFlags } from "./update.command.ts";

const readMetadata = readMetadataFile({
  openError: (args) => new SsoUpdateMetadataFileError(args),
  nonUtf8Error: (args) =>
    new SsoUpdateMetadataFileError({ message: args.message, reason: "invalid_content" }),
});

const readAttributeMapping = readAttributeMappingFile({
  openError: (args) => new SsoUpdateAttributeMappingFileError(args),
});

const mapGetStatusOrNetwork = mapHttpError({
  networkError: SsoUpdateNetworkError,
  statusError: SsoUpdateUnexpectedStatusError,
  networkMessage: (cause) => `failed to get sso provider: ${cause}`,
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
 * Value-taking flags for `pflagArgvScan`: each consumes the next argv token
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

const handleGetError = (ref: string, providerId: string, cause: SupabaseApiError) =>
  Effect.gen(function* () {
    const mapped = yield* Effect.flip(mapGetStatusOrNetwork(cause));
    if (mapped._tag === "SsoUpdateUnexpectedStatusError") {
      const upgradeSuggested = yield* suggestUpgrade({
        projectRef: ref,
        featureKey: "auth.saml_2",
        statusCode: mapped.status,
        response: gateResponse(cause),
      });
      if (mapped.status === 404) {
        return yield* Effect.fail(
          new SsoUpdateNotFoundError({
            message: `An identity provider with ID ${JSON.stringify(providerId)} could not be found.`,
            upgradeSuggested,
          }),
        );
      }
      return yield* Effect.fail(
        new SsoUpdateUnexpectedStatusError({
          status: mapped.status,
          body: mapped.body,
          message: mapped.message,
          upgradeSuggested,
        }),
      );
    }
    return yield* Effect.fail(mapped);
  });

interface ExistingDomainItem {
  readonly domain?: string;
}

/**
 * Narrows a raw GET-provider JSON body to the `domains` shape `mergeDomains`
 * consumes.
 */
function extractDomainItems(parsed: unknown): ReadonlyArray<ExistingDomainItem> | undefined {
  if (parsed === null || typeof parsed !== "object") {
    return undefined;
  }
  const domains = (parsed as Record<string, unknown>)["domains"];
  if (!Array.isArray(domains)) {
    return undefined;
  }
  return domains.map((item): ExistingDomainItem => {
    if (item === null || typeof item !== "object") {
      return {};
    }
    const domain = (item as Record<string, unknown>)["domain"];
    return typeof domain === "string" ? { domain } : {};
  });
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
  const goOutputFlag = yield* OutputFlag;
  const api = yield* CommandPlatformApi;
  const httpClient = yield* HttpClient.HttpClient;
  const cliSettings = yield* CommandSettings;
  const resolver = yield* ProjectRefResolver;
  const linkedProjectCache = yield* LinkedProjectCache;
  const telemetryState = yield* TelemetryState;
  const identityStitch = yield* Effect.serviceOption(IdentityStitch);
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
    const scan = pflagArgvScan(rawArgs, SSO_UPDATE_COMMAND_PATH, SSO_UPDATE_SCAN_SPEC);
    const occurrences = scan.occurrences;

    // Validate against pflag's accepted values before the missing-value,
    // arity, and mutex checks — pflag fails on the first invalid occurrence
    // even if a later one overrides it, and its bool parsing excludes
    // `yes`/`no`.
    const skipUrlValidation = yield* Result.match(
      pflagBoolValue(occurrences, "skip-url-validation"),
      {
        onFailure: (message: string) => Effect.fail(new SsoInvalidFlagValueError({ message })),
        onSuccess: Effect.succeed,
      },
    );
    const nameIdFormat = yield* Result.match(
      pflagEnumValue(occurrences, "name-id-format", SSO_NAME_ID_FORMATS),
      {
        onFailure: (message: string) => Effect.fail(new SsoInvalidFlagValueError({ message })),
        onSuccess: Effect.succeed,
      },
    );

    // A bare value-taking flag as the final token is a pflag parse error,
    // reported even when the arg count is also wrong. The TS parser accepts
    // it as unset, so this must run before the arity check.
    if (scan.missingValueError !== undefined) {
      return yield* Effect.fail(new SsoFlagNeedsArgumentError({ message: scan.missingValueError }));
    }

    // Arity is counted from pflag-effective positionals, which shift
    // whenever pflag consumed a flag token as another flag's value — the TS
    // parser's own arity check can't see that. Gated on `anchored`: an
    // unscoped scan has no positional information.
    if (scan.anchored && scan.positionals.length !== 1) {
      return yield* Effect.fail(
        new SsoUpdateArityError({
          message: `accepts 1 arg(s), received ${scan.positionals.length}`,
        }),
      );
    }

    // Reconcile the effective `--profile` before the workdir check: an
    // unloadable profile loses to an arity violation but beats the workdir
    // and mutex checks. Where the scan and parser agree this resolves to
    // `none` and the config layer's apiUrl is already correct.
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
        ? Effect.succeed<Option.Option<Redacted.Redacted<string>> | undefined>(undefined)
        : Effect.catch(reconciledTokenCached, () =>
            Effect.succeed(Option.none<Redacted.Redacted<string>>()),
          );

    // Validate the effective `--workdir` after arity but before the mutex
    // checks: it loses to an arity violation but beats a mutex violation and
    // any GET/PUT.
    yield* validatePflagWorkdir(scan);

    for (const group of SSO_UPDATE_MUTEX_GROUPS) {
      const changed = group.filter((flagName) => occurrences.has(flagName));
      if (changed.length > 1) {
        return yield* Effect.fail(
          new SsoMutexFlagError({
            message: cobraMutuallyExclusiveErrorMessage(group, changed),
          }),
        );
      }
    }

    // Everything below reads pflag-effective values from the scan rather
    // than the TS-parsed flags — see `add.handler.ts` and `pflag-reconcile.ts`.
    const projectRefFlag = pflagStringValue(occurrences, "project-ref");
    const metadataFile = pflagStringValue(occurrences, "metadata-file");
    const metadataUrl = pflagStringValue(occurrences, "metadata-url");
    const attributeMappingFile = pflagStringValue(occurrences, "attribute-mapping-file");
    const domains = pflagSliceValue(occurrences, "domains", flags.domains);
    const addDomains = pflagSliceValue(occurrences, "add-domains", flags.addDomains);
    const removeDomains = pflagSliceValue(occurrences, "remove-domains", flags.removeDomains);

    const providerId = yield* validateUuid(flags.providerId).pipe(
      Result.match({ onFailure: Effect.fail, onSuccess: Effect.succeed }),
    );

    const ref = yield* resolver.resolve(projectRefFlag);

    // Use the pflag-reconciled profile's host when it disagreed with
    // `--profile`, otherwise the config layer's.
    const apiUrl = Option.getOrElse(profileApiUrl, () => cliSettings.apiUrl);

    yield* Effect.gen(function* () {
      const fetching =
        output.format === "text" ? yield* output.task("Updating SSO provider...") : undefined;

      // The typed client bakes the layer's apiUrl in at construction, so when
      // the reconciled profile differs, the GET must be issued raw against
      // the effective host, matching the PUT's host. Error mapping and the
      // spinner/suggestion ordering mirror the typed path (`handleGetError`).
      const rawGetProvider = Effect.gen(function* () {
        const tokenOpt =
          reconciledTokenCached !== undefined
            ? yield* Effect.flatMap(reconciledTokenCached, (resolved) =>
                Option.isSome(resolved)
                  ? Effect.succeed(resolved)
                  : Effect.fail(new SsoAccessTokenError({ message: missingAccessTokenMessage() })),
              )
            : yield* resolveAccessToken;
        const request = HttpClientRequest.get(
          `${apiUrl}/v1/projects/${ref}/config/auth/sso/providers/${providerId}`,
        ).pipe(
          Option.isSome(tokenOpt) ? HttpClientRequest.bearerToken(tokenOpt.value) : (req) => req,
          HttpClientRequest.setHeader("User-Agent", cliSettings.userAgent),
        );
        const response = yield* httpClient.execute(request).pipe(
          Effect.tapError(() => fetching?.fail() ?? Effect.void),
          Effect.mapError(
            (cause) =>
              new SsoUpdateNetworkError({
                message: `failed to get sso provider: ${String(cause)}`,
              }),
          ),
        );
        // Every Management API response goes through the identity stitch
        // once per command; this raw GET must too, before the status gate.
        // `serviceOption`: absent outside the real CLI tree (handler-level
        // tests), where no telemetry runtime exists to stitch into.
        if (Option.isSome(identityStitch)) {
          yield* identityStitch.value.stitch(response);
        }
        const rawBody = yield* response.text.pipe(
          Effect.tapError(() => fetching?.fail() ?? Effect.void),
          Effect.mapError(
            (cause) =>
              new SsoUpdateNetworkError({
                message: `failed to get sso provider: ${String(cause)}`,
              }),
          ),
        );
        const contentType = response.headers["content-type"] ?? "";
        if (response.status === 200 && contentType.includes("json")) {
          // A 200 body that fails JSON.parse exits with JSON.parse's own
          // message, before any PUT.
          let parsed: unknown;
          try {
            parsed = JSON.parse(rawBody);
          } catch (cause) {
            yield* fetching?.fail() ?? Effect.void;
            return yield* Effect.fail(
              new SsoUpdateNetworkError({
                message: `failed to get sso provider: ${cause instanceof Error ? cause.message : String(cause)}`,
                decode: true,
              }),
            );
          }
          return { domains: extractDomainItems(parsed) };
        }
        // A 200 without a JSON content type falls into this branch too.
        yield* fetching?.fail() ?? Effect.void;
        const bodyText = sanitizeErrorBody(rawBody);
        const upgradeSuggested = yield* suggestUpgrade({
          projectRef: ref,
          featureKey: "auth.saml_2",
          statusCode: response.status,
          response,
          apiUrl,
          ...(yield* Effect.map(reconciledTokenForAux, (token) =>
            token !== undefined ? { accessToken: token } : {},
          )),
        });
        if (response.status === 404) {
          return yield* Effect.fail(
            new SsoUpdateNotFoundError({
              message: `An identity provider with ID ${JSON.stringify(providerId)} could not be found.`,
              upgradeSuggested,
            }),
          );
        }
        return yield* Effect.fail(
          new SsoUpdateUnexpectedStatusError({
            status: response.status,
            body: bodyText,
            message: `unexpected error fetching identity provider: ${bodyText}`,
            upgradeSuggested,
          }),
        );
      });

      // Always GETs first, regardless of which flags are set.
      const existing = yield* Option.isSome(profileApiUrl)
        ? rawGetProvider
        : api.v1.getASsoProvider({ ref, provider_id: providerId }).pipe(
            Effect.tapError(() => fetching?.fail() ?? Effect.void),
            Effect.catch((cause) => handleGetError(ref, providerId, cause)),
          );

      const body: Record<string, unknown> = {};

      if (Option.isSome(metadataFile)) {
        const xml = yield* readMetadata(metadataFile.value);
        body["metadata_xml"] = xml;
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
        body["metadata_url"] = metadataUrl.value;
      }

      if (Option.isSome(attributeMappingFile)) {
        const mapping = yield* readAttributeMapping(attributeMappingFile.value);
        body["attribute_mapping"] = mapping;
      }

      if (domains.length > 0) {
        body["domains"] = [...domains];
      } else {
        // `domains` is always recomputed and sent, even when no domain flag
        // was passed; an empty merged set serializes as `"domains":[]`, never omitted.
        body["domains"] = mergeDomains(existing.domains, addDomains, removeDomains);
      }

      if (Option.isSome(nameIdFormat)) {
        body["name_id_format"] = nameIdFormat.value;
      }

      const tokenOpt =
        reconciledTokenCached !== undefined
          ? yield* Effect.flatMap(reconciledTokenCached, (resolved) =>
              Option.isSome(resolved)
                ? Effect.succeed(resolved)
                : Effect.fail(new SsoAccessTokenError({ message: missingAccessTokenMessage() })),
            )
          : yield* resolveAccessToken;

      // See `add.handler.ts` for the rationale behind `bearerToken(Redacted)`.
      const request = HttpClientRequest.put(
        `${apiUrl}/v1/projects/${ref}/config/auth/sso/providers/${providerId}`,
      ).pipe(
        Option.isSome(tokenOpt) ? HttpClientRequest.bearerToken(tokenOpt.value) : (req) => req,
        HttpClientRequest.setHeader("User-Agent", cliSettings.userAgent),
        // See `add.handler.ts` — key order matters for cli-e2e parity.
        HttpClientRequest.bodyText(encodeGoStructJsonBody(body), "application/json"),
      );

      const response = yield* httpClient.execute(request).pipe(
        Effect.tapError(() => fetching?.fail() ?? Effect.void),
        Effect.mapError(
          (cause) =>
            new SsoUpdateNetworkError({
              message: `failed to update sso provider: ${String(cause)}`,
            }),
        ),
      );

      if (response.status !== 200) {
        const rawBody = yield* response.text.pipe(Effect.orElseSucceed(() => ""));
        // Cap + sanitize to match `mapHttpError`'s defenses; see add handler for the rationale.
        const bodyText = sanitizeErrorBody(rawBody);
        const upgradeSuggested = yield* suggestUpgrade({
          projectRef: ref,
          featureKey: "auth.saml_2",
          statusCode: response.status,
          response,
          apiUrl,
          ...(yield* Effect.map(reconciledTokenForAux, (token) =>
            token !== undefined ? { accessToken: token } : {},
          )),
        });
        yield* fetching?.fail() ?? Effect.void;
        return yield* Effect.fail(
          // Reuses the GET error message even for PUT.
          new SsoUpdateUnexpectedStatusError({
            status: response.status,
            body: bodyText,
            message: `unexpected error fetching identity provider: ${bodyText}`,
            upgradeSuggested,
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
        yield* output.raw(encodeGoYaml(parsedJson, GO_SSO_PROVIDER_RESPONSE));
        return;
      }
      if (goFmt === "toml") {
        // Same TOML-encode-failure pattern as list/show.
        const toml = yield* Effect.try({
          try: () => encodeGoToml(parsedJson, GO_SSO_PROVIDER_RESPONSE),
          catch: (cause) =>
            new SsoTomlEncodeError({
              message: `failed to output toml: ${cause instanceof Error ? cause.message : String(cause)}`,
            }),
        });
        yield* output.raw(toml);
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

      yield* output.raw(renderSingleProvider(toSsoProviderView(parsedJson)));
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
