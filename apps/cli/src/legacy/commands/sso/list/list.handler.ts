import { operationDefinitions } from "@supabase/api/effect";
import { Effect, Option } from "effect";

import { LegacyPlatformApi } from "../../../auth/legacy-platform-api.service.ts";
import { LegacyProjectRefResolver } from "../../../config/legacy-project-ref.service.ts";
import { LegacyOutputFlag } from "../../../../shared/legacy/global-flags.ts";
import { Output } from "../../../../shared/output/output.service.ts";
import {
  encodeEnv,
  encodeGoJson,
  encodeToml,
  encodeYaml,
} from "../../../shared/legacy-go-output.encoders.ts";
import { sanitizeLegacyErrorBody } from "../../../shared/legacy-http-errors.ts";
import { LegacyLinkedProjectCache } from "../../../telemetry/legacy-linked-project-cache.service.ts";
import { LegacyTelemetryState } from "../../../telemetry/legacy-telemetry-state.service.ts";
import { legacySuggestUpgrade } from "../../../shared/legacy-upgrade-suggest.ts";
import {
  LegacySsoListNetworkError,
  LegacySsoListSamlDisabledError,
  LegacySsoListUnexpectedStatusError,
} from "../sso.errors.ts";
import { renderListProviders, toLegacySsoProviderView } from "../sso.format.ts";
import type { LegacySsoListFlags } from "./list.command.ts";

const SAML_DISABLED_MESSAGE =
  "Looks like SAML 2.0 support is not enabled for this project. Please use the dashboard to enable it.";

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

function readString(obj: Record<string, unknown>, key: string): string | undefined {
  const value = obj[key];
  return typeof value === "string" ? value : undefined;
}

function readRequiredString(obj: Record<string, unknown>, key: string): string {
  return readString(obj, key) ?? "";
}

function listNetworkError(cause: unknown): LegacySsoListNetworkError {
  return new LegacySsoListNetworkError({ message: `failed to list sso providers: ${cause}` });
}

function normalizeProviderItem(raw: unknown): Record<string, unknown> {
  const item = asRecord(raw);
  const saml = asRecord(item["saml"]);
  const domainsRaw = item["domains"];
  return {
    id: readRequiredString(item, "id"),
    saml:
      Object.keys(saml).length === 0
        ? undefined
        : {
            id: readRequiredString(saml, "id"),
            entity_id: readRequiredString(saml, "entity_id"),
            metadata_url: readString(saml, "metadata_url"),
            metadata_xml: readString(saml, "metadata_xml"),
            name_id_format: readString(saml, "name_id_format"),
            attribute_mapping: saml["attribute_mapping"],
          },
    domains: Array.isArray(domainsRaw)
      ? domainsRaw.map((domain) => {
          const entry = asRecord(domain);
          return {
            id: readRequiredString(entry, "id"),
            domain: readString(entry, "domain"),
            created_at: readString(entry, "created_at"),
            updated_at: readString(entry, "updated_at"),
          };
        })
      : undefined,
    created_at: readString(item, "created_at"),
    updated_at: readString(item, "updated_at"),
  };
}

function readProviderItems(body: unknown): ReadonlyArray<Record<string, unknown>> | undefined {
  const items = asRecord(body)["items"];
  if (!Array.isArray(items)) {
    return undefined;
  }
  return items.map(normalizeProviderItem);
}

export const legacySsoList = Effect.fn("legacy.sso.list")(function* (flags: LegacySsoListFlags) {
  const output = yield* Output;
  const goOutputFlag = yield* LegacyOutputFlag;
  const api = yield* LegacyPlatformApi;
  const resolver = yield* LegacyProjectRefResolver;
  const linkedProjectCache = yield* LegacyLinkedProjectCache;
  const telemetryState = yield* LegacyTelemetryState;

  yield* Effect.gen(function* () {
    const ref = yield* resolver.resolve(flags.projectRef);

    yield* Effect.gen(function* () {
      const fetching =
        output.format === "text" ? yield* output.task("Fetching SSO providers...") : undefined;

      // The real list payload can omit `items[].saml.id`, while the generated
      // contract still requires it. Use the raw API response here so we can
      // keep Go-parity list behavior without weakening the shared schema for
      // other SSO operations.
      const response = yield* api
        .executeRaw(operationDefinitions.v1ListAllSsoProvider, { ref })
        .pipe(
          Effect.tapError(() => fetching?.fail() ?? Effect.void),
          Effect.mapError(listNetworkError),
        );

      if (response.status !== 200) {
        const body = sanitizeLegacyErrorBody(
          yield* response.text.pipe(Effect.orElseSucceed(() => "")),
        );
        yield* fetching?.fail() ?? Effect.void;
        yield* legacySuggestUpgrade({
          projectRef: ref,
          featureKey: "auth.saml_2",
          statusCode: response.status,
        });
        if (response.status === 404) {
          return yield* Effect.fail(
            new LegacySsoListSamlDisabledError({ message: SAML_DISABLED_MESSAGE }),
          );
        }
        return yield* Effect.fail(
          new LegacySsoListUnexpectedStatusError({
            status: response.status,
            body,
            message: `unexpected error listing identity providers: ${body}`,
          }),
        );
      }

      const parsed = yield* response.json.pipe(
        Effect.tapError(() => fetching?.fail() ?? Effect.void),
        Effect.mapError(listNetworkError),
      );
      const items = readProviderItems(parsed);
      if (items === undefined) {
        yield* fetching?.fail() ?? Effect.void;
        return yield* Effect.fail(
          new LegacySsoListNetworkError({
            message: "failed to list sso providers: response.items was not an array",
          }),
        );
      }
      yield* fetching?.clear() ?? Effect.void;

      const goFmt = Option.getOrUndefined(goOutputFlag);
      const payload = { providers: items };

      if (goFmt === "json") {
        yield* output.raw(encodeGoJson(payload));
        return;
      }
      if (goFmt === "yaml") {
        yield* output.raw(encodeYaml(payload));
        return;
      }
      if (goFmt === "toml") {
        yield* output.raw(encodeToml(payload) + "\n");
        return;
      }
      if (goFmt === "env") {
        yield* output.raw(encodeEnv(payload) + "\n");
        return;
      }

      if (output.format === "json" || output.format === "stream-json") {
        yield* output.success("", payload);
        return;
      }

      yield* output.raw(renderListProviders(items.map(toLegacySsoProviderView)));
    }).pipe(Effect.ensuring(linkedProjectCache.cache(ref)));
  }).pipe(Effect.ensuring(telemetryState.flush));
});
