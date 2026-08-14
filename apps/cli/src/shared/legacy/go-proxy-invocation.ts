import { Context, Effect, Layer, Ref } from "effect";

interface GoProxyInvocationShape {
  readonly markDelegated: Effect.Effect<void>;
  readonly wasDelegated: Effect.Effect<boolean>;
}

export class GoProxyInvocation extends Context.Service<GoProxyInvocation, GoProxyInvocationShape>()(
  "supabase/legacy/GoProxyInvocation",
) {}

export const goProxyInvocationLayer = Layer.effect(
  GoProxyInvocation,
  Effect.gen(function* () {
    const delegated = yield* Ref.make(false);
    return GoProxyInvocation.of({
      markDelegated: Ref.set(delegated, true),
      wasDelegated: Ref.get(delegated),
    });
  }),
);
