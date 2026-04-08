import { Effect } from "effect";
import type * as EffectModule from "effect/Effect";

import { type SupabaseApiClientShape, SupabaseApiClient } from "./client.ts";

export type EffectClient<Operations extends object> = {
  readonly [Key in keyof Operations]: Operations[Key] extends (
    ...args: infer Args
  ) => EffectModule.Effect<infer Output, infer Error, SupabaseApiClient>
    ? (...args: Args) => EffectModule.Effect<Output, Error>
    : Operations[Key] extends object
      ? EffectClient<Operations[Key]>
      : never;
};

function isRecord(value: unknown): value is Readonly<Record<PropertyKey, unknown>> {
  return typeof value === "object" && value !== null;
}

export function makeEffectApiClient<Operations extends object>(
  client: SupabaseApiClientShape,
  operations: Operations,
): EffectClient<Operations> {
  const bindOperation = (value: unknown): unknown => {
    if (typeof value === "function") {
      return (...args: ReadonlyArray<unknown>) =>
        (
          value as (
            ...args: ReadonlyArray<unknown>
          ) => Effect.Effect<unknown, unknown, SupabaseApiClient>
        )(...args).pipe(Effect.provideService(SupabaseApiClient, client));
    }
    if (isRecord(value)) {
      return Object.fromEntries(
        Object.entries(value).map(([key, entry]) => [key, bindOperation(entry)]),
      );
    }
    return value;
  };

  return bindOperation(operations) as EffectClient<Operations>;
}
