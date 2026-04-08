import type * as ManagedRuntime from "effect/ManagedRuntime";
import type * as Effect from "effect/Effect";

export type PromiseClient<Operations extends object> = {
  readonly [Key in keyof Operations]: Operations[Key] extends (
    ...args: infer Args
  ) => Effect.Effect<infer Output, infer _Error, never>
    ? (...args: Args) => Promise<Output>
    : Operations[Key] extends object
      ? PromiseClient<Operations[Key]>
      : never;
};

function isRecord(value: unknown): value is Readonly<Record<PropertyKey, unknown>> {
  return typeof value === "object" && value !== null;
}

export function makePromiseClient<Operations extends object, Error>(
  runtime: ManagedRuntime.ManagedRuntime<never, Error>,
  operations: Operations,
): PromiseClient<Operations> {
  const wrapOperation = (value: unknown): unknown => {
    if (typeof value === "function") {
      return (...args: ReadonlyArray<unknown>) =>
        runtime.runPromise(
          (value as (...args: ReadonlyArray<unknown>) => Effect.Effect<unknown, unknown, never>)(
            ...args,
          ),
        );
    }
    if (isRecord(value)) {
      return Object.fromEntries(
        Object.entries(value).map(([key, entry]) => [key, wrapOperation(entry)]),
      );
    }
    return value;
  };

  return wrapOperation(operations) as PromiseClient<Operations>;
}
