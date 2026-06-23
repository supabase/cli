import { Effect } from "effect";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientError from "effect/unstable/http/HttpClientError";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";

import { LegacyCliConfig } from "../../../config/legacy-cli-config.service.ts";
import { sanitizeLegacyErrorBody } from "../../../shared/legacy-http-errors.ts";
import { requestWithAuth } from "../../../shared/legacy-raw-http.ts";
import { resolveLegacyAccessToken } from "../../../shared/legacy-resolve-token.ts";
import {
  LegacyConfigPushListAddonsNetworkError,
  LegacyConfigPushListAddonsStatusError,
} from "./push.errors.ts";

/**
 * Cost matrix entry: the addon variant's display name and price description,
 * used to render the cost-aware confirmation prompt (Go `push.CostItem`).
 */
export interface LegacyCostItem {
  readonly name: string;
  readonly price: string;
}

/**
 * Port of Go `push.getCostMatrix` (`internal/config/push/push.go`).
 *
 * GETs `/v1/projects/{ref}/billing/addons` and builds a map of `addon.type` →
 * `{ name, price }` for every addon that has exactly one variant.
 *
 * Uses raw HTTP rather than the typed client: the generated `available_addons[].type`
 * is a closed enum (`custom_domain | compute_instance | …`) that rejects values
 * the Go CLI accepts as a plain string (e.g. the `"api"` GraphQL addon in
 * `TestPushConfig`). Mirrors the `sso add` / `postgres-config` raw-HTTP precedent.
 */
export const getCostMatrix = Effect.fn("legacy.config.push.cost-matrix")(function* (ref: string) {
  const httpClient = yield* HttpClient.HttpClient;
  const cliConfig = yield* LegacyCliConfig;
  const tokenOpt = yield* resolveLegacyAccessToken;

  const request = requestWithAuth(
    HttpClientRequest.get(`${cliConfig.apiUrl}/v1/projects/${ref}/billing/addons`),
    tokenOpt,
    cliConfig.userAgent,
  );

  const response = yield* httpClient.execute(request).pipe(
    Effect.mapError((cause) => {
      const description = HttpClientError.isHttpClientError(cause)
        ? (cause.reason.description ?? cause.reason._tag)
        : String(cause);
      return new LegacyConfigPushListAddonsNetworkError({
        message: `failed to list addons: ${description}`,
      });
    }),
  );

  if (response.status !== 200) {
    const rawBody = yield* response.text.pipe(Effect.orElseSucceed(() => ""));
    const body = sanitizeLegacyErrorBody(rawBody);
    return yield* Effect.fail(
      new LegacyConfigPushListAddonsStatusError({
        status: response.status,
        body,
        message: `unexpected list addons status ${response.status}: ${body}`,
      }),
    );
  }

  const rawBody = yield* response.text;
  const parsed = yield* Effect.try({
    try: () => JSON.parse(rawBody) as unknown,
    catch: (cause) =>
      new LegacyConfigPushListAddonsNetworkError({
        message: `failed to list addons: ${String(cause)}`,
      }),
  });

  const costMatrix = new Map<string, LegacyCostItem>();
  for (const addon of readAddons(parsed)) {
    const variant = addon.variants.length === 1 ? addon.variants[0] : undefined;
    if (variant !== undefined) {
      costMatrix.set(addon.type, { name: variant.name, price: variant.price.description });
    }
  }
  return costMatrix;
});

interface ParsedAddon {
  readonly type: string;
  readonly variants: ReadonlyArray<{
    readonly name: string;
    readonly price: { readonly description: string };
  }>;
}

/** Tolerantly extracts `available_addons` with a string `type` (Go uses `string`, not an enum). */
function readAddons(parsed: unknown): ReadonlyArray<ParsedAddon> {
  if (typeof parsed !== "object" || parsed === null) return [];
  const available = (parsed as { available_addons?: unknown }).available_addons;
  if (!Array.isArray(available)) return [];
  const addons: Array<ParsedAddon> = [];
  for (const entry of available) {
    if (typeof entry !== "object" || entry === null) continue;
    const type = (entry as { type?: unknown }).type;
    const variantsRaw = (entry as { variants?: unknown }).variants;
    if (typeof type !== "string" || !Array.isArray(variantsRaw)) continue;
    const variants = variantsRaw.map((v) => {
      const name = (v as { name?: unknown }).name;
      const price = (v as { price?: unknown }).price;
      const description = (price as { description?: unknown } | undefined)?.description;
      return {
        name: typeof name === "string" ? name : "",
        price: { description: typeof description === "string" ? description : "" },
      };
    });
    addons.push({ type, variants });
  }
  return addons;
}
