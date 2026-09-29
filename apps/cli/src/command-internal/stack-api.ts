import { Context, Crypto, Effect, FileSystem, Layer, Option, Path, Scope } from "effect";
import { FetchHttpClient, HttpClient } from "effect/unstable/http";
import { ChildProcessSpawner } from "effect/unstable/process";
import {
  create,
  discover,
  find,
  open,
  type CreateOptions,
  type DestroyResult,
  type FindOptions,
  type FoundStack,
  type OpenOptions,
  type Stack,
  type StackError,
} from "@supabase/stack/effect";

type DiscoverResult = Effect.Success<ReturnType<typeof discover>>;

/** Operations used by the CLI stack boundary; a handle lasts until its scope closes. */
export class StackApi extends Context.Service<
  StackApi,
  {
    readonly create: (options: CreateOptions) => Effect.Effect<Stack, StackError, Scope.Scope>;
    readonly open: (options: OpenOptions) => Effect.Effect<Stack, StackError, Scope.Scope>;
    readonly discover: (
      options: Parameters<typeof discover>[0],
    ) => Effect.Effect<DiscoverResult, StackError>;
    readonly find: (options: FindOptions) => Effect.Effect<Option.Option<FoundStack>, StackError>;
  }
>()("supabase/stack/StackApi") {}

export const stackApiLayer = Layer.effect(
  StackApi,
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const crypto = yield* Crypto.Crypto;
    const childProcess = yield* ChildProcessSpawner.ChildProcessSpawner;
    const http = yield* HttpClient.HttpClient;
    const provideServices = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      effect.pipe(
        Effect.provideService(FileSystem.FileSystem, fileSystem),
        Effect.provideService(Path.Path, path),
        Effect.provideService(Crypto.Crypto, crypto),
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, childProcess),
        Effect.provideService(HttpClient.HttpClient, http),
      );
    const createStack = Effect.fn("StackApi.create")((options: CreateOptions) =>
      provideServices(create(options)),
    );
    const openStack = Effect.fn("StackApi.open")((options: OpenOptions) =>
      provideServices(open(options)),
    );
    const discoverStacks = Effect.fn("StackApi.discover")(
      (options: Parameters<typeof discover>[0]) => provideServices(discover(options)),
    );
    const findStack = Effect.fn("StackApi.find")((options: FindOptions) =>
      provideServices(find(options)),
    );
    return StackApi.of({
      create: createStack,
      open: openStack,
      discover: discoverStacks,
      find: findStack,
    });
  }),
).pipe(Layer.provide(FetchHttpClient.layer));

/** Describes the engine resources a destroy left behind and the commands that remove them. */
export const skippedRuntimeCleanupWarning = (
  subject: string,
  result: Extract<DestroyResult, { readonly runtimeCleanup: "skipped" }>,
): string => {
  const engineName = result.engine === "docker" ? "Docker" : "Podman";
  return [
    `${engineName} was unavailable, so ${engineName} resources for ${subject} were not removed. Once it is running, remove them with:`,
    ...result.cleanupCommands.map((command) => `  ${command}`),
  ].join("\n");
};

export type { Stack };
