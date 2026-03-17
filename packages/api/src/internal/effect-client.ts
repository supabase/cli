import { Effect } from "effect";
import type * as EffectModule from "effect/Effect";
import * as Struct from "effect/Struct";

import { type SupabaseApiClientShape, SupabaseApiClient } from "./client.ts";

type EffectClient<Operations extends object> = {
  readonly [Key in keyof Operations]: Operations[Key] extends (
    ...args: infer Args
  ) => EffectModule.Effect<infer Output, infer Error, SupabaseApiClient>
    ? (...args: Args) => EffectModule.Effect<Output, Error>
    : never;
};

type StripV1Prefix<Key extends PropertyKey> = Key extends `v1${infer Rest}`
  ? Uncapitalize<Rest>
  : Key;

type V1ApiClient<Operations extends object> = {
  readonly [Key in keyof Operations as StripV1Prefix<Key>]: Operations[Key];
};

type ApiClientFacade<Operations extends object> = V1ApiClient<Operations> & {
  readonly v1: V1ApiClient<Operations>;
};

interface ToEffectOperation extends Struct.Lambda {
  <Args extends ReadonlyArray<unknown>, Output, Error>(
    self: (...args: Args) => EffectModule.Effect<Output, Error, SupabaseApiClient>,
  ): (...args: Args) => EffectModule.Effect<Output, Error>;
  readonly "~lambda.out": this["~lambda.in"] extends (
    ...args: infer Args
  ) => EffectModule.Effect<infer Output, infer Error, SupabaseApiClient>
    ? (...args: Args) => EffectModule.Effect<Output, Error>
    : never;
}

const toEffectOperation = (client: SupabaseApiClientShape) =>
  Struct.lambda<ToEffectOperation>(
    (operation) =>
      (...args) =>
        operation(...args).pipe(Effect.provideService(SupabaseApiClient, client)),
  );

export function makeEffectApiClient<Operations extends object>(
  client: SupabaseApiClientShape,
  operations: Operations,
): EffectClient<Operations> {
  return Struct.map(operations, toEffectOperation(client));
}

function stripV1MethodName<Key extends `v1${string}`>(
  key: Key,
): Uncapitalize<Key extends `v1${infer Rest}` ? Rest : never>;
function stripV1MethodName<Key extends PropertyKey>(key: Key): Key;
function stripV1MethodName(key: PropertyKey) {
  if (typeof key !== "string") {
    return key;
  }

  if (!key.startsWith("v1") || key.length < 3) {
    return key;
  }

  const first = key.slice(2, 3).toLowerCase();
  return `${first}${key.slice(3)}`;
}

export function makeV1ApiClientFacade<Operations extends object>(
  operations: Operations,
): ApiClientFacade<Operations>;
export function makeV1ApiClientFacade(operations: object) {
  const v1: Record<PropertyKey, unknown> = {};
  for (const [key, value] of Object.entries(operations)) {
    v1[stripV1MethodName(key)] = value;
  }
  return {
    ...v1,
    v1,
  };
}
