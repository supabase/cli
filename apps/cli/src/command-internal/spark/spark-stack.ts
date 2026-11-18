import type { ServiceInstance, Stack } from "@supabase/stack/effect";
import { Context, Effect, Layer, Option, Path } from "effect";

import { CommandSettings } from "../../config/command-settings.service.ts";
import { StackApi } from "../stack-api.ts";
import { SparkBackendError } from "./spark-project.ts";

const fail = (cause: { readonly message: string }) =>
  new SparkBackendError({ message: cause.message, cause });

/** The project's local Spark stack, as `db reset` drives it. */
export class SparkStack extends Context.Service<
  SparkStack,
  {
    /**
     * Runs `effect` with every stack service stopped, since Spark holds an exclusive lock on its
     * database while it serves, and starts them again afterwards when they were running.
     */
    readonly whileStopped: <A, E, R>(
      effect: Effect.Effect<A, E, R>,
    ) => Effect.Effect<A, E | SparkBackendError, R>;
  }
>()("supabase/cli/SparkStack") {}

type AnyInstance = Effect.Success<Stack["services"]["list"]>[number];

const isSpark = (instance: AnyInstance): instance is ServiceInstance<"spark"> =>
  instance.service === "spark";

/** Opens the project's stack and finds its Spark member, when both exist. */
const openSpark = Effect.fn("SparkStack.open")(function* () {
  const api = yield* StackApi;
  const settings = yield* CommandSettings;
  const path = yield* Path.Path;
  const stateRoot = path.join(settings.supabaseHome, "stacks");
  const found = yield* api
    .find({ stateRoot, projectRoot: path.resolve(settings.workdir) })
    .pipe(Effect.mapError(fail));
  if (Option.isNone(found)) return Option.none<{ stack: Stack; spark: ServiceInstance<"spark"> }>();
  const stack = yield* api
    .open({
      id: found.value.definition.id,
      stateRoot,
      cacheRoot: path.join(settings.supabaseHome, "cache", "stack"),
    })
    .pipe(Effect.mapError(fail));
  const instances = yield* stack.services.list.pipe(Effect.orElseSucceed(() => []));
  for (const instance of instances)
    if (isSpark(instance)) return Option.some({ stack, spark: instance });
  return Option.none<{ stack: Stack; spark: ServiceInstance<"spark"> }>();
});

const running = (spark: ServiceInstance<"spark">) =>
  spark.status.pipe(
    Effect.map(({ lifecycle }) => lifecycle === "running"),
    Effect.orElseSucceed(() => false),
  );

export const sparkStackLayer = Layer.effect(
  SparkStack,
  Effect.gen(function* () {
    const context = yield* Effect.context<StackApi | CommandSettings | Path.Path>();
    const opened = openSpark().pipe(Effect.provideContext(context));
    return SparkStack.of({
      whileStopped: (effect) =>
        Effect.scoped(
          Effect.gen(function* () {
            const found = yield* opened;
            const live =
              Option.isSome(found) && (yield* running(found.value.spark)) ? found.value : undefined;
            yield* Effect.annotateCurrentSpan({ "spark.running": live !== undefined });
            if (live !== undefined) yield* live.stack.composition.stop.pipe(Effect.mapError(fail));
            const result = yield* effect;
            if (live !== undefined)
              yield* live.stack.composition.start.pipe(
                Effect.andThen(live.spark.ready),
                Effect.mapError(fail),
              );
            return result;
          }),
        ).pipe(Effect.withSpan("SparkStack.whileStopped")),
    });
  }),
);
