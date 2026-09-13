import { Context, Crypto, Effect, FileSystem, Layer, Path } from "effect";
import {
  createStack,
  discoverStacks,
  findStack,
  inspectStack,
  openStack,
  type StackDiscoveryResult,
} from "@supabase/stack/effect";
import { ChildProcessSpawner } from "effect/unstable/process";

export class StackApi extends Context.Service<
  StackApi,
  {
    readonly findStack: (
      ...args: Parameters<typeof findStack>
    ) => Effect.Effect<
      Effect.Success<ReturnType<typeof findStack>>,
      Effect.Error<ReturnType<typeof findStack>>
    >;
    readonly createStack: (
      ...args: Parameters<typeof createStack>
    ) => Effect.Effect<
      Effect.Success<ReturnType<typeof createStack>>,
      Effect.Error<ReturnType<typeof createStack>>
    >;
    readonly openStack: (
      ...args: Parameters<typeof openStack>
    ) => Effect.Effect<
      Effect.Success<ReturnType<typeof openStack>>,
      Effect.Error<ReturnType<typeof openStack>>
    >;
    readonly inspectStack: (
      ...args: Parameters<typeof inspectStack>
    ) => Effect.Effect<
      Effect.Success<ReturnType<typeof inspectStack>>,
      Effect.Error<ReturnType<typeof inspectStack>>
    >;
    readonly discoverStacks: (
      ...args: Parameters<typeof discoverStacks>
    ) => Effect.Effect<StackDiscoveryResult, Effect.Error<ReturnType<typeof discoverStacks>>>;
  }
>()("supabase/experimental-stack/StackApi") {}

export const stackApiLayer = Layer.effect(
  StackApi,
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const crypto = yield* Crypto.Crypto;
    const childProcess = yield* ChildProcessSpawner.ChildProcessSpawner;
    const provideServices = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      effect.pipe(
        Effect.provideService(FileSystem.FileSystem, fileSystem),
        Effect.provideService(Path.Path, path),
        Effect.provideService(Crypto.Crypto, crypto),
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, childProcess),
      );
    return {
      findStack: (...args: Parameters<typeof findStack>) => provideServices(findStack(...args)),
      createStack: (...args: Parameters<typeof createStack>) =>
        provideServices(createStack(...args)),
      openStack: (...args: Parameters<typeof openStack>) => provideServices(openStack(...args)),
      inspectStack: (...args: Parameters<typeof inspectStack>) =>
        provideServices(inspectStack(...args)),
      discoverStacks: (...args: Parameters<typeof discoverStacks>) =>
        provideServices(discoverStacks(...args)),
    };
  }),
);
