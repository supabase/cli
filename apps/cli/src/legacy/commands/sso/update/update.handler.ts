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
  PERSISTENT_VALUE_FLAG_NAMES,
  PERSISTENT_VALUE_FLAG_SHORTHANDS,
  pflagArgvScan,
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
import {
  legacyGateResponse,
  legacySuggestUpgrade,
} from "../../../shared/legacy-upgrade-suggest.ts";
import {
  LegacySsoFlagNeedsArgumentError,
  LegacySsoInvalidFlagValueError,
  LegacySsoMutexFlagError,
  LegacySsoUpdateArityError,
  LegacySsoUpdateAttributeMappingFileError,
  LegacySsoUpdateMetadataFileError,
  LegacySsoUpdateNetworkError,
  LegacySsoUpdateNotFoundError,
  LegacySsoUpdateUnexpectedStatusError,
} from "../sso.errors.ts";
import { renderSingleProvider, toLegacySsoProviderView, validateUuid } from "../sso.format.ts";
import { validateMetadataUrl } from "../sso.metadata-url.ts";
import {
  legacySsoPflagBoolValue,
  legacySsoPflagEnumValue,
  legacySsoPflagSliceValue,
  legacySsoPflagStringValue,
  legacySsoResolvePflagProfileApiUrl,
  legacySsoValidatePflagWorkdir,
} from "../sso.pflag-reconcile.ts";
import {
  LEGACY_SSO_NAME_ID_FORMATS,
  readAttributeMappingFile,
  readMetadataFile,
} from "../sso.saml.ts";
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
 * Every value-taking (non-boolean) flag reachable when `sso update` parses:
 * the command's own (`update.command.ts`) plus the root's persistent value
 * flags — these tell `pflagArgvScan` which bare tokens consume the next argv
 * token as their value (and therefore which tokens are pflag-effective
 * positionals). `--skip-url-validation` is this command's only boolean flag
 * and is deliberately excluded; booleans never consume a following token.
 * `sso update` declares no shorthands of its own (`cmd/sso.go:170-176`), so
 * only the persistent `-o` is mapped.
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
    if (mapped._tag === "LegacySsoUpdateUnexpectedStatusError") {
      yield* legacySuggestUpgrade({
        projectRef: ref,
        featureKey: "auth.saml_2",
        statusCode: mapped.status,
        response: legacyGateResponse(cause),
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

/**
 * Narrows a raw GET-provider JSON body to the `domains` shape `mergeDomains`
 * consumes — the untyped counterpart of the generated client's provider
 * schema, for the reconciled-profile GET path.
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
  // Mirrors Go's `update.go:84-109` — seed from current domains, apply
  // removals, then add new entries. Go uses a `map[string]bool`, so iteration
  // order is unspecified; integration tests sort before asserting. Go's seed
  // check is nil-ness only (`domain.Domain != nil`), so an empty-string domain
  // from the GET response is kept, not filtered.
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
    // cobra runs `ValidateArgs` (`command.go:968`, before every hook), then
    // `ValidateFlagGroups` (`command.go:1010`), before `RunE`
    // (`command.go:1015`), and Go's provider-ID format check lives inside
    // `RunE` (`cmd/sso.go:90-91`) — so an arity violation must win over a
    // mutex violation, and both must win over an invalid provider ID. Keep
    // this block ahead of `validateUuid` below to match that precedence.
    //
    // "Set" follows cobra's `pflag.Changed` — whether the flag was passed at
    // all — not the resulting value. `--domains`/`--add-domains`/
    // `--remove-domains` all default to `[]`, so `--domains=` (parses to an
    // empty array) must still count as "set"; gating on `.length > 0` would
    // miss it, the same "changed vs truthy" gap CLI-1860 fixed for
    // `functions download`'s `--use-docker`.
    //
    // The scan is pflag-faithful: a bare `--metadata-file --metadata-url` is
    // pflag consuming `--metadata-url` as `metadata-file`'s (oddly named)
    // value, not two flags being set — see `pflagArgvScan`.
    const scan = pflagArgvScan(rawArgs, SSO_UPDATE_COMMAND_PATH, SSO_UPDATE_SCAN_SPEC);
    const occurrences = scan.occurrences;

    // pflag calls `Value.Set` for every occurrence in argv order, and an
    // invalid value fails `ParseFlags` (cobra `command.go:919`) before
    // `ValidateArgs`, every hook, and `RunE` — reachable here because the
    // Effect parser resolves repeated flags first-wins without validating
    // later occurrences (`--name-id-format=<valid> --name-id-format=bogus`
    // parses) and accepts `yes`/`no`, which `strconv.ParseBool` rejects
    // (binary-verified, PR #5974 review round 4). These checks precede the
    // missing-value check because a missing value can only arise at the
    // final argv token, so every recorded occurrence pflag would reject sits
    // earlier in its sequential walk (binary-verified:
    // `--skip-url-validation=yes --domains` names the invalid argument, not
    // the missing one). Flags are checked in Go registration order
    // (`cmd/sso.go:170-176`); when a single argv holds invalid occurrences
    // of BOTH flags, pflag names whichever comes first in argv — a
    // divergence this fixed order cannot see, accepted as unreachable
    // through sane usage. The same helpers yield the pflag-effective
    // (last-occurrence) values the handler acts on below.
    const skipUrlValidation = yield* Result.match(
      legacySsoPflagBoolValue(occurrences, "skip-url-validation"),
      {
        onFailure: (message: string) =>
          Effect.fail(new LegacySsoInvalidFlagValueError({ message })),
        onSuccess: Effect.succeed,
      },
    );
    const nameIdFormat = yield* Result.match(
      legacySsoPflagEnumValue(occurrences, "name-id-format", LEGACY_SSO_NAME_ID_FORMATS),
      {
        onFailure: (message: string) =>
          Effect.fail(new LegacySsoInvalidFlagValueError({ message })),
        onSuccess: Effect.succeed,
      },
    );

    // pflag fails `ParseFlags` (cobra `command.go:919`) when a bare
    // value-taking flag is the final token (`sso update <id> --domains`) —
    // before `ValidateArgs`, every hook, and `RunE`, so Go reports the
    // missing argument even when the arg count is also wrong
    // (binary-verified: `sso update a b --domains`). The Effect parser
    // accepts that argv (the flag parses as unset), so no GET/PUT may happen
    // here either. Keep this ahead of the arity check.
    if (scan.missingValueError !== undefined) {
      return yield* Effect.fail(
        new LegacySsoFlagNeedsArgumentError({ message: scan.missingValueError }),
      );
    }

    // `ExactArgs(1)` (`cmd/sso.go:87`) counts pflag-effective positionals,
    // which shift away from what the Effect parser saw whenever pflag
    // consumed a flag token as a value: `--domains --metadata-url u <id>` is
    // pflag handing `--metadata-url` to `--domains` and leaving BOTH `u` and
    // `<id>` positional — Go rejects the arg count before any hook, flag
    // validation, or request. The parser's own arity check can't see this,
    // so re-count from the scan (gated on `anchored`: an unscoped scan has
    // no positional information).
    if (scan.anchored && scan.positionals.length !== 1) {
      return yield* Effect.fail(
        new LegacySsoUpdateArityError({
          message: `accepts 1 arg(s), received ${scan.positionals.length}`,
        }),
      );
    }

    // Go's root `PersistentPreRunE` loads the pflag/viper-effective
    // `--profile`/`SUPABASE_PROFILE` (`LoadProfile`, `cmd/root.go:98-102`)
    // immediately BEFORE `ChangeWorkDir`, so an unloadable profile loses to
    // an arity violation but beats the workdir check, the mutex checks, and
    // any GET/PUT — and a loadable one decides which API host receives them.
    // Reachable exactly where the scan and the parser disagree (see
    // `add.handler.ts` and `legacySsoResolvePflagProfileApiUrl` — PR #5974
    // review round 7); where they agree this is `none` and the config
    // layer's client/apiUrl below are already pflag-effective.
    const profileApiUrl = yield* legacySsoResolvePflagProfileApiUrl(scan);

    // Go's root `PersistentPreRunE` chdir's to the pflag/viper-effective
    // `--workdir`/`SUPABASE_WORKDIR` (`ChangeWorkDir`, `cmd/root.go:104`,
    // `internal/utils/misc.go:238-257`) after `ValidateArgs` and before
    // `ValidateFlagGroups` (`command.go:1010`), so a missing directory loses
    // to an arity violation but beats a mutex violation and any GET/PUT
    // (binary-verified: `sso update a b --workdir /missing` reports the
    // arity error; `sso update <id> --workdir /missing --domains a
    // --add-domains b` reports the chdir failure — PR #5974 review round 6).
    yield* legacySsoValidatePflagWorkdir(scan);

    for (const group of SSO_UPDATE_MUTEX_GROUPS) {
      const changed = group.filter((flagName) => occurrences.has(flagName));
      if (changed.length > 1) {
        return yield* Effect.fail(
          new LegacySsoMutexFlagError({
            message: cobraMutuallyExclusiveErrorMessage(group, changed),
          }),
        );
      }
    }

    // Reconcile everything the handler acts on to the pflag-effective values
    // from the same scan — the Effect parser refuses to consume flag-shaped
    // tokens as values while pflag consumes them unconditionally, and
    // resolves repeated flags first-wins while pflag is last-wins, so the
    // two can disagree on which flags are set and what they hold. See
    // `add.handler.ts` and `sso.pflag-reconcile.ts` for the full rationale
    // (CLI-1982). `--name-id-format` and `--skip-url-validation` were
    // reconciled above, alongside their pflag value validation.
    const projectRefFlag = legacySsoPflagStringValue(occurrences, "project-ref");
    const metadataFile = legacySsoPflagStringValue(occurrences, "metadata-file");
    const metadataUrl = legacySsoPflagStringValue(occurrences, "metadata-url");
    const attributeMappingFile = legacySsoPflagStringValue(occurrences, "attribute-mapping-file");
    const domains = legacySsoPflagSliceValue(occurrences, "domains", flags.domains);
    const addDomains = legacySsoPflagSliceValue(occurrences, "add-domains", flags.addDomains);
    const removeDomains = legacySsoPflagSliceValue(
      occurrences,
      "remove-domains",
      flags.removeDomains,
    );

    const providerId = yield* validateUuid(flags.providerId).pipe(
      Result.match({ onFailure: Effect.fail, onSuccess: Effect.succeed }),
    );

    const ref = yield* resolver.resolve(projectRefFlag);

    // Effective API base URL: the pflag-reconciled profile's when the scan
    // and the parser disagreed on `--profile`, the config layer's otherwise.
    const apiUrl = Option.getOrElse(profileApiUrl, () => cliConfig.apiUrl);

    yield* Effect.gen(function* () {
      const fetching =
        output.format === "text" ? yield* output.task("Updating SSO provider...") : undefined;

      // The typed client bakes the layer's apiUrl in at construction
      // (`legacy-platform-api.layer.ts:73`), so when the reconciled profile
      // differs the GET must be issued raw against the effective host — Go
      // GETs and PUTs the same viper-effective profile host (`update.go:42`),
      // and a GET to the layer's host would be a request Go never makes. The
      // error mapping and the spinner-fail/suggestion stderr ordering mirror
      // the typed path (`handleGetError`) exactly.
      const rawGetProvider = Effect.gen(function* () {
        const tokenOpt = yield* resolveLegacyAccessToken;
        const request = HttpClientRequest.get(
          `${apiUrl}/v1/projects/${ref}/config/auth/sso/providers/${providerId}`,
        ).pipe(
          Option.isSome(tokenOpt) ? HttpClientRequest.bearerToken(tokenOpt.value) : (req) => req,
          HttpClientRequest.setHeader("User-Agent", cliConfig.userAgent),
        );
        const response = yield* httpClient.execute(request).pipe(
          Effect.tapError(() => fetching?.fail() ?? Effect.void),
          Effect.mapError(
            (cause) =>
              new LegacySsoUpdateNetworkError({
                message: `failed to get sso provider: ${String(cause)}`,
              }),
          ),
        );
        if (response.status !== 200) {
          yield* fetching?.fail() ?? Effect.void;
          const rawBody = yield* response.text.pipe(Effect.orElseSucceed(() => ""));
          const bodyText = sanitizeLegacyErrorBody(rawBody);
          yield* legacySuggestUpgrade({
            projectRef: ref,
            featureKey: "auth.saml_2",
            statusCode: response.status,
            response,
          });
          if (response.status === 404) {
            return yield* Effect.fail(
              new LegacySsoUpdateNotFoundError({
                message: `An identity provider with ID ${JSON.stringify(providerId)} could not be found.`,
              }),
            );
          }
          return yield* Effect.fail(
            new LegacySsoUpdateUnexpectedStatusError({
              status: response.status,
              body: bodyText,
              message: `unexpected error fetching identity provider: ${bodyText}`,
            }),
          );
        }
        const parsed = yield* response.json.pipe(Effect.orElseSucceed((): unknown => ({})));
        return { domains: extractDomainItems(parsed) };
      });

      // Go's `update.go:42` always GETs first, regardless of which flags are set.
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
        body["metadata_url"] = metadataUrl.value;
      }

      if (Option.isSome(attributeMappingFile)) {
        const mapping = yield* readAttributeMapping(attributeMappingFile.value);
        body["attribute_mapping"] = mapping;
      }

      if (domains.length > 0) {
        body["domains"] = [...domains];
      } else {
        // Go's `update.go:84` reads as gating the merge on
        // `params.AddDomains != nil || params.RemoveDomains != nil`, but
        // `cmd/sso.go:171-172` declares both flags with a non-nil `[]string{}`
        // default and passes them unconditionally — so from the CLI that
        // condition is always true and every `sso update` PUT recomputes and
        // sends `domains`, even when no domain flag was passed. `body.Domains`
        // is a non-nil `*[]string` under `json:"domains,omitempty"`, so an
        // empty merged set serializes as `"domains":[]`, never omitted
        // (CLI-1981; live-captured against the Go binary).
        body["domains"] = mergeDomains(existing.domains, addDomains, removeDomains);
      }

      if (Option.isSome(nameIdFormat)) {
        body["name_id_format"] = nameIdFormat.value;
      }

      const tokenOpt = yield* resolveLegacyAccessToken;

      // See `add.handler.ts` for the rationale behind `bearerToken(Redacted)`.
      const request = HttpClientRequest.put(
        `${apiUrl}/v1/projects/${ref}/config/auth/sso/providers/${providerId}`,
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
          response,
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
