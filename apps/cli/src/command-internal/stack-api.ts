import { Context, Crypto, Effect, FileSystem, Layer, Path } from "effect";
import { FetchHttpClient, HttpClient } from "effect/unstable/http";
import { ChildProcessSpawner } from "effect/unstable/process";
import {
  create,
  discover,
  open,
  type CreateOptions,
  type OpenOptions,
  type Stack,
} from "@supabase/stack/effect";
import { resolveStackIdentity } from "@supabase/stack/internal/identity";

type DiscoverResult = Effect.Success<ReturnType<typeof discover>>;
type StackError = Effect.Error<ReturnType<typeof create>>;
type IdentityResult = Effect.Success<ReturnType<typeof resolveStackIdentity>>;
type IdentityError = Effect.Error<ReturnType<typeof resolveStackIdentity>>;

/** Operations used by the CLI stack boundary. */
export class StackApi extends Context.Service<
  StackApi,
  {
    readonly create: (options: CreateOptions) => Effect.Effect<Stack, StackError>;
    readonly open: (options: OpenOptions) => Effect.Effect<Stack, StackError>;
    readonly discover: (
      options: Pick<CreateOptions, "stateRoot">,
    ) => Effect.Effect<DiscoverResult, StackError>;
    readonly resolveIdentity: (
      options: Parameters<typeof resolveStackIdentity>[0],
    ) => Effect.Effect<IdentityResult, IdentityError>;
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
      (options: Pick<CreateOptions, "stateRoot">) => provideServices(discover(options)),
    );
    const resolveIdentity = Effect.fn("StackApi.resolveIdentity")(
      (options: Parameters<typeof resolveStackIdentity>[0]) =>
        provideServices(resolveStackIdentity(options)),
    );
    return StackApi.of({
      create: createStack,
      open: openStack,
      discover: discoverStacks,
      resolveIdentity,
    });
  }),
).pipe(Layer.provide(FetchHttpClient.layer));

export type { Stack };
