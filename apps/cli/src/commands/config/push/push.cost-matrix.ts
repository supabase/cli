import { Effect } from "effect";

import { CommandPlatformApi } from "../../../auth/command-platform-api.service.ts";
import { mapHttpError } from "../../../command-internal/http-errors.ts";
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

const mapListAddonsError = mapHttpError({
  networkError: ConfigPushListAddonsNetworkError,
  statusError: ConfigPushListAddonsStatusError,
  networkMessage: (cause) => `failed to list addons: ${cause}`,
  statusMessage: (status, body) => `unexpected list addons status ${status}: ${body}`,
});

/**
 * Lists the project's addons and builds a map of `addon.type` → `{ name, price }` for every
 * addon that has exactly one variant.
 */
export const getCostMatrix = Effect.fn("config.push.fetchCostMatrix")(function* (ref: string) {
  const api = yield* CommandPlatformApi;
  const addons = yield* api.v1.listProjectAddons({ ref }).pipe(Effect.catch(mapListAddonsError));

  const costMatrix = new Map<string, CostItem>();
  for (const addon of addons.available_addons) {
    const variant = addon.variants.length === 1 ? addon.variants[0] : undefined;
    if (variant !== undefined) {
      costMatrix.set(addon.type, { name: variant.name, price: variant.price.description });
    }
  }
  yield* Effect.annotateCurrentSpan("addon.count", costMatrix.size);
  return costMatrix;
});
