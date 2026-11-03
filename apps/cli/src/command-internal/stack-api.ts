import { Context, Crypto, Effect, FileSystem, Layer, Option, Path, Scope } from "effect";
import { FetchHttpClient, HttpClient } from "effect/http";
import { ChildProcessSpawner } from "effect/process";
import {
  create,
  discover,
  find,
  findDeleted,
  open,
  type CreateOptions,
  type DeletedStack,
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
    readonly findDeleted: (
      options: Parameters<typeof findDeleted>[0],
    ) => Effect.Effect<Option.Option<DeletedStack>, StackError>;
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
    const findDeletedStack = Effect.fn("StackApi.findDeleted")(
      (options: Parameters<typeof findDeleted>[0]) => provideServices(findDeleted(options)),
    );
    return StackApi.of({
      create: createStack,
      open: openStack,
      discover: discoverStacks,
      find: findStack,
      findDeleted: findDeletedStack,
    });
  }),
).pipe(Layer.provide(FetchHttpClient.layer));

export type { Stack };
