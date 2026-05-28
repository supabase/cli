import { Effect, Option } from "effect";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";

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

export const legacySsoAdd = Effect.fn("legacy.sso.add")(function* (flags: LegacySsoAddFlags) {
  const output = yield* Output;
  const goOutputFlag = yield* LegacyOutputFlag;
  const httpClient = yield* HttpClient.HttpClient;
  const cliConfig = yield* LegacyCliConfig;
  const resolver = yield* LegacyProjectRefResolver;
  const linkedProjectCache = yield* LegacyLinkedProjectCache;
  const telemetryState = yield* LegacyTelemetryState;

  yield* Effect.gen(function* () {
    if (Option.isSome(flags.metadataFile) && Option.isSome(flags.metadataUrl)) {
      return yield* Effect.fail(
        new LegacySsoMutexFlagError({
          message: "only one of --metadata-file or --metadata-url may be set",
        }),
      );
    }

    const ref = yield* resolver.resolve(flags.projectRef);

    yield* Effect.gen(function* () {
      // Permissive request body. We POST as raw JSON to preserve any
      // user-supplied keys inside `attribute_mapping.keys.<x>` (notably the
      // `default` field that Go encodes via an inline anonymous struct and
      // that the generated `V1CreateASsoProviderInput` schema omits).
      const body: Record<string, unknown> = {
        type: flags.type,
      };

      if (Option.isSome(flags.metadataFile)) {
        const xml = yield* readMetadata(flags.metadataFile.value);
        body["metadata_xml"] = xml;
      } else if (Option.isSome(flags.metadataUrl)) {
        if (!flags.skipUrlValidation) {
          yield* validateMetadataUrl(flags.metadataUrl.value).pipe(
            // Note: Go suffixes with no trailing period (matches `create.go:47`).
            Effect.mapError(
              (cause) =>
                new LegacySsoAddMetadataFileError({
                  message: `${cause.message} Use --skip-url-validation to suppress this error`,
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
      }

      if (Option.isSome(flags.nameIdFormat)) {
        body["name_id_format"] = flags.nameIdFormat.value;
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
