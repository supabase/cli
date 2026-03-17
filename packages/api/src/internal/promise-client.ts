import type * as ManagedRuntime from "effect/ManagedRuntime";
import type * as Effect from "effect/Effect";
import * as Struct from "effect/Struct";

export type PromiseClient<Operations extends object> = {
  readonly [Key in keyof Operations]: Operations[Key] extends (
    ...args: infer Args
  ) => Effect.Effect<infer Output, infer _Error, never>
    ? (...args: Args) => Promise<Output>
    : never;
};

interface ToPromiseOperation extends Struct.Lambda {
  <Args extends ReadonlyArray<unknown>, Output, Error>(
    self: (...args: Args) => Effect.Effect<Output, Error, never>,
  ): (...args: Args) => Promise<Output>;
  readonly "~lambda.out": this["~lambda.in"] extends (
    ...args: infer Args
  ) => Effect.Effect<infer Output, infer _Error, never>
    ? (...args: Args) => Promise<Output>
    : never;
}

const toPromiseOperation = <RuntimeError>(
  runtime: ManagedRuntime.ManagedRuntime<never, RuntimeError>,
) =>
  Struct.lambda<ToPromiseOperation>(
    (operation) =>
      (...args) =>
        runtime.runPromise(operation(...args)),
  );

export function makePromiseClient<Operations extends object, Error>(
  runtime: ManagedRuntime.ManagedRuntime<never, Error>,
  operations: Operations,
): PromiseClient<Operations> {
  return Struct.map(operations, toPromiseOperation(runtime));
}
