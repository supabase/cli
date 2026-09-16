import { Effect } from "effect";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientError from "effect/unstable/http/HttpClientError";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";

import { CommandSettings } from "../../../config/command-settings.service.ts";
import { sanitizeErrorBody } from "../../../command-internal/http-errors.ts";
import { requestWithAuth } from "../../../command-internal/raw-http.ts";
import { resolveAccessToken } from "../../../command-internal/resolve-token.ts";
import {
  ConfigPushListAddonsNetworkError,
  ConfigPushListAddonsStatusError,
} from "./push.errors.ts";

/** Cost matrix entry: the addon variant's display name and price description, used to render
 *  the cost-aware confirmation prompt. */
export interface CostItem {
  readonly name: string;
  readonly price: string;
}

/**
 * GETs `/v1/projects/{ref}/billing/addons` and builds a map of `addon.type` →
 * `{ name, price }` for every addon that has exactly one variant.
 *
 * Uses raw HTTP rather than the typed client: the generated
 * `available_addons[].type` is a closed enum (`custom_domain |
 * compute_instance | …`) that rejects values accepted as a plain string
 * (e.g. the `"api"` GraphQL addon). Mirrors the `sso add` /
 * `postgres-config` raw-HTTP precedent.
 */
export const getCostMatrix = Effect.fn("config.push.cost-matrix")(function* (ref: string) {
  const httpClient = yield* HttpClient.HttpClient;
  const cliSettings = yield* CommandSettings;
  const tokenOpt = yield* resolveAccessToken;

  const request = requestWithAuth(
    HttpClientRequest.get(`${cliSettings.apiUrl}/v1/projects/${ref}/billing/addons`),
    tokenOpt,
    cliSettings.userAgent,
  );

  const response = yield* httpClient.execute(request).pipe(
    Effect.mapError((cause) => {
      const description = HttpClientError.isHttpClientError(cause)
        ? (cause.reason.description ?? cause.reason._tag)
        : String(cause);
      return new ConfigPushListAddonsNetworkError({
        message: `failed to list addons: ${description}`,
      });
    }),
  );

  if (response.status !== 200) {
    const rawBody = yield* response.text.pipe(Effect.orElseSucceed(() => ""));
    const body = sanitizeErrorBody(rawBody);
    return yield* Effect.fail(
      new ConfigPushListAddonsStatusError({
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
      new ConfigPushListAddonsNetworkError({
        message: `failed to list addons: ${String(cause)}`,
        decode: true,
      }),
  });

  const costMatrix = new Map<string, CostItem>();
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

/** Tolerantly extracts `available_addons` with a string `type`, since the API response itself
 *  uses a plain string, not the enum the generated client declares. */
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
