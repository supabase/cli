import { Effect, Option, Stdio } from "effect";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";

import { LegacyCliConfig } from "../../../config/legacy-cli-config.service.ts";
import { LegacyProjectRefResolver } from "../../../config/legacy-project-ref.service.ts";
import { LegacyOutputFlag } from "../../../../shared/legacy/global-flags.ts";
import {
  cobraMutuallyExclusiveErrorMessage,
  pflagLongFlagOccurrences,
} from "../../../../shared/cli/cobra-flag-groups.ts";
import { Output } from "../../../../shared/output/output.service.ts";
import {
  encodeGoJson,
  encodeGoStructJsonBody,
  encodeToml,
  encodeYaml,
} from "../../../shared/legacy-go-output.encoders.ts";
import { sanitizeLegacyErrorBody } from "../../../shared/legacy-http-errors.ts";
import { resolveLegacyAccessToken } from "../../../shared/legacy-resolve-token.ts";
import { LegacyLinkedProjectCache } from "../../../telemetry/legacy-linked-project-cache.service.ts";
import { LegacyTelemetryState } from "../../../telemetry/legacy-telemetry-state.service.ts";
import { legacySuggestUpgrade } from "../../../shared/legacy-upgrade-suggest.ts";
import {
  LegacySsoAddAttributeMappingFileError,
  LegacySsoAddMetadataFileError,
  LegacySsoAddNetworkError,
  LegacySsoAddSamlDisabledError,
  LegacySsoAddUnexpectedStatusError,
  LegacySsoMutexFlagError,
} from "../sso.errors.ts";
import { renderSingleProvider, toLegacySsoProviderView } from "../sso.format.ts";
import { validateMetadataUrl } from "../sso.metadata-url.ts";
import { legacySsoPflagSliceValue, legacySsoPflagStringValue } from "../sso.pflag-reconcile.ts";
import { readAttributeMappingFile, readMetadataFile } from "../sso.saml.ts";
import type { LegacySsoAddFlags } from "./add.command.ts";

const SAML_DISABLED_MESSAGE =
  "SAML 2.0 support is not enabled for this project. Please enable it through the dashboard";

const readMetadata = readMetadataFile({
  openError: (args) => new LegacySsoAddMetadataFileError(args),
  nonUtf8Error: (args) => new LegacySsoAddMetadataFileError({ message: args.message }),
});

const readAttributeMapping = readAttributeMappingFile({
  openError: (args) => new LegacySsoAddAttributeMappingFileError(args),
});

const SSO_ADD_COMMAND_PATH = ["sso", "add"] as const;

/**
 * `sso add`'s single mutually-exclusive group, in Go's registration order
 * (`cmd/sso.go:164` — `MarkFlagsMutuallyExclusive("metadata-file",
 * "metadata-url")`). Registration order determines the first bracket of
 * cobra's error template; only the violating subset gets sorted.
 */
const SSO_ADD_MUTEX_GROUP = ["metadata-file", "metadata-url"] as const;

/**
 * Every value-taking (non-boolean) flag `sso add` declares
 * (`add.command.ts`) — tells `pflagLongFlagOccurrences` which bare tokens
 * consume the next argv token as their value. `--skip-url-validation` is
 * this command's only boolean flag and is deliberately excluded; booleans
 * never consume a following token. `--type`'s `-t` shorthand is not covered
 * — the raw-argv scan only understands long flags, same limitation as
 * `sso update`'s scan (a shorthand's consumed value could in principle be
 * misread, but pflag would fail `-t`'s enum validation on any dash-prefixed
 * value before flag groups are even checked).
 */
const SSO_ADD_VALUE_FLAG_NAMES = new Set([
  "project-ref",
  "type",
  "domains",
  "metadata-file",
  "metadata-url",
  "attribute-mapping-file",
  "name-id-format",
]);

export const legacySsoAdd = Effect.fn("legacy.sso.add")(function* (flags: LegacySsoAddFlags) {
  const output = yield* Output;
  const goOutputFlag = yield* LegacyOutputFlag;
  const httpClient = yield* HttpClient.HttpClient;
  const cliConfig = yield* LegacyCliConfig;
  const resolver = yield* LegacyProjectRefResolver;
  const linkedProjectCache = yield* LegacyLinkedProjectCache;
  const telemetryState = yield* LegacyTelemetryState;
  const stdio = yield* Stdio.Stdio;
  const rawArgs = yield* stdio.args;

  yield* Effect.gen(function* () {
    // cobra runs `ValidateFlagGroups` (`command.go:1010`) before `RunE`
    // (`command.go:1014`), so the mutex check must precede everything Go does
    // inside `RunE`. Keep this block first.
    //
    // "Set" follows cobra's `pflag.Changed` — whether the flag was passed at
    // all — not the resulting value: `--metadata-file= --metadata-url x` must
    // still trip the error even though the file path is empty. Scanning raw
    // argv keeps detection aligned with pflag's semantics rather than with
    // whatever the TS parser produced — e.g. a bare
    // `--metadata-file --metadata-url` parses to two `none`s here but is a
    // single consumed value in pflag (CLI-1982).
    const occurrences = pflagLongFlagOccurrences(
      rawArgs,
      SSO_ADD_COMMAND_PATH,
      SSO_ADD_VALUE_FLAG_NAMES,
    );
    const changed = SSO_ADD_MUTEX_GROUP.filter((flagName) => occurrences.has(flagName));
    if (changed.length > 1) {
      return yield* Effect.fail(
        new LegacySsoMutexFlagError({
          message: cobraMutuallyExclusiveErrorMessage(SSO_ADD_MUTEX_GROUP, changed),
        }),
      );
    }

    // The scan and the Effect parser can disagree on more than the mutex:
    // pflag consumes flag-shaped tokens as values, the Effect parser does
    // not. Everything the handler acts on below is therefore reconciled to
    // the pflag-effective values from the same scan, so a suppressed mutex
    // can never pair with a metadata source pflag never set (e.g.
    // `--project-ref --metadata-file x.xml --metadata-url u`, where Go hands
    // `--metadata-file` to `--project-ref` and fails ref validation without
    // ever touching metadata). `--type` keeps its parsed value: `-t` is a
    // shorthand the scan cannot see, and required-ness is parser-enforced.
    // `--name-id-format` and `--skip-url-validation` keep their parsed
    // values gated on the scan agreeing they were passed at all.
    const projectRef = legacySsoPflagStringValue(occurrences, "project-ref");
    const metadataFile = legacySsoPflagStringValue(occurrences, "metadata-file");
    const metadataUrl = legacySsoPflagStringValue(occurrences, "metadata-url");
    const attributeMappingFile = legacySsoPflagStringValue(occurrences, "attribute-mapping-file");
    const domains = legacySsoPflagSliceValue(occurrences, "domains", flags.domains);
    const nameIdFormat = occurrences.has("name-id-format")
      ? flags.nameIdFormat
      : Option.none<never>();
    const skipUrlValidation = occurrences.has("skip-url-validation")
      ? flags.skipUrlValidation
      : false;

    const ref = yield* resolver.resolve(projectRef);

    yield* Effect.gen(function* () {
      // Permissive request body. We POST as raw JSON to preserve any
      // user-supplied keys inside `attribute_mapping.keys.<x>` (notably the
      // `default` field that Go encodes via an inline anonymous struct and
      // that the generated `V1CreateASsoProviderInput` schema omits).
      const body: Record<string, unknown> = {
        type: flags.type,
      };

      if (Option.isSome(metadataFile)) {
        const xml = yield* readMetadata(metadataFile.value);
        body["metadata_xml"] = xml;
      } else if (Option.isSome(metadataUrl)) {
        if (!skipUrlValidation) {
          yield* validateMetadataUrl(metadataUrl.value).pipe(
            // Note: Go suffixes with no trailing period (matches `create.go:47`).
            Effect.mapError(
              (cause) =>
                new LegacySsoAddMetadataFileError({
                  message: `${cause.message} Use --skip-url-validation to suppress this error`,
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
      }

      if (Option.isSome(nameIdFormat)) {
        body["name_id_format"] = nameIdFormat.value;
      }

      const creating =
        output.format === "text" ? yield* output.task("Adding SSO provider...") : undefined;

      const tokenOpt = yield* resolveLegacyAccessToken;

      // Use `HttpClientRequest.bearerToken(Redacted)` rather than unwrapping the
      // redacted token into a plain string ourselves — this preserves the
      // redaction marker on the Authorization header so that any future debug
      // serialisation of the request stays opaque about the bearer token value.
      const request = HttpClientRequest.post(
        `${cliConfig.apiUrl}/v1/projects/${ref}/config/auth/sso/providers`,
      ).pipe(
        Option.isSome(tokenOpt) ? HttpClientRequest.bearerToken(tokenOpt.value) : (req) => req,
        HttpClientRequest.setHeader("User-Agent", cliConfig.userAgent),
        // Body keys serialised in Go-struct order (alphabetical) so the
        // cli-e2e replay server's string-compare body match succeeds.
        HttpClientRequest.bodyText(encodeGoStructJsonBody(body), "application/json"),
      );

      const response = yield* httpClient.execute(request).pipe(
        Effect.tapError(() => creating?.fail() ?? Effect.void),
        Effect.mapError(
          (cause) =>
            new LegacySsoAddNetworkError({
              message: `failed to create sso provider: ${String(cause)}`,
            }),
        ),
      );

      if (response.status !== 201) {
        const rawBody = yield* response.text.pipe(Effect.orElseSucceed(() => ""));
        // Apply the same cap + control-character sanitisation the typed-client error
        // mapper uses (`mapLegacyHttpError`) so error output stays bounded and
        // shell-safe — the raw-HTTP path must not skip these defences.
        const bodyText = sanitizeLegacyErrorBody(rawBody);
        yield* legacySuggestUpgrade({
          projectRef: ref,
          featureKey: "auth.saml_2",
          statusCode: response.status,
          response,
        });
        yield* creating?.fail() ?? Effect.void;
        if (response.status === 404) {
          return yield* Effect.fail(
            new LegacySsoAddSamlDisabledError({ message: SAML_DISABLED_MESSAGE }),
          );
        }
        return yield* Effect.fail(
          new LegacySsoAddUnexpectedStatusError({
            status: response.status,
            body: bodyText,
            message: `Unexpected error adding identity provider: ${bodyText}`,
          }),
        );
      }

      const parsedJson = yield* response.json.pipe(Effect.orElseSucceed((): unknown => ({})));
      yield* creating?.clear() ?? Effect.void;

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
        // Go's `create.go:94-96` returns nil for env — emit nothing.
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
