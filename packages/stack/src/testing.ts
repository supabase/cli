import { Config, Crypto, Effect, FileSystem, Option, Path, Ref, Schema, Scope } from "effect";
// oxlint-disable-next-line effecttsgo/node-builtin-import -- FileSystem exposes no OS temp or home directory path for the shared roots.
import { homedir, tmpdir, userInfo } from "node:os";
import type { PlatformError } from "effect/PlatformError";
import { defaultRuntime } from "./Artifacts.ts";
import * as StackEffect from "./effect.ts";
import {
  acquire,
  stackAdapter,
  type CallOptions,
  type Plain,
  type Promised,
  type ServiceInstances,
  type Stack,
} from "./PromiseClient.ts";
import { StackError, stackError } from "./Rpc.ts";
import {
  allowedEndpointNames,
  ServiceCreationInput as CreationSchema,
} from "./services/Catalog.ts";

type Kind = StackEffect.ServiceCreationInput["service"];
type Creation<K extends Kind> = Extract<StackEffect.ServiceCreationInput, { readonly service: K }>;

/** A service kind to compose, optionally with config and endpoint overrides. */
export type TestService<K extends Kind = Kind> = K extends Kind
  ?
      | K
      | {
          readonly service: K;
          readonly config?: Partial<Creation<K>["config"]>;
          readonly endpoints?: Creation<K>["endpoints"];
        }
  : never;
/** A test service with plain configuration values. */
export type PlainTestService = Plain<TestService>;
/** The service kinds a test stack selects. */
export type TestServiceKind<S> = S extends Kind
  ? S
  : S extends { readonly service: infer K extends Kind }
    ? K
    : never;

/** Test stack options; omitted roots use shared per-user or temporary locations. */
export interface TestStackOptions<S> {
  /** Defaults to `["database"]`. */
  readonly services?: S;
  /** Defaults to `SUPABASE_STACK_TEST_RUNTIME`, then the platform's default runtime. */
  readonly runtime?: StackEffect.CreateOptions["runtime"];
  readonly stateRoot?: string;
  readonly cacheRoot?: string;
  /**
   * A caller-owned project root; by default a temporary one is removed on disposal. Default
   * Storage and Functions directories live in the temporary root, never in a caller's root.
   */
  readonly projectRoot?: string;
}

/** A composed, ready session stack that is destroyed when its scope closes. */
export interface EffectTestStack<K extends Kind = "database"> {
  readonly stack: StackEffect.Stack;
  readonly services: { readonly [P in K]: StackEffect.ServiceInstances[P] };
  readonly projectRoot: string;
  /**
   * Saves the database data under `name` as an instance snapshot, which other stacks cannot evict
   * and destroying this stack removes; the composition stops and restarts around it.
   */
  readonly checkpoint: (name: string) => Effect.Effect<void, StackError>;
  /**
   * Restores the data saved by `checkpoint(name)` and waits until every service is ready. An
   * unknown name fails before any data changes; the composition restarts even when reset fails.
   */
  readonly reset: (name: string) => Effect.Effect<void, StackError>;
}

/** A composed, ready session stack; disposal destroys it, then closes its client. */
export interface TestStack<K extends Kind = "database"> extends AsyncDisposable {
  readonly stack: Stack;
  readonly services: { readonly [P in K]: ServiceInstances[P] };
  readonly projectRoot: string;
  readonly checkpoint: Promised<EffectTestStack["checkpoint"]>;
  readonly reset: Promised<EffectTestStack["reset"]>;
}

const runtimeOverride = Config.option(
  Config.literals(["native", "docker", "podman"], "SUPABASE_STACK_TEST_RUNTIME"),
);

const testFailure = (operation: string) => (cause: unknown) => stackError(operation, cause);

/** Local-development configuration for each kind, with every endpoint on an automatic port. */
const localCreation = Effect.fnUntraced(function* (
  kind: Kind,
  dataRoot: Effect.Effect<string, PlatformError, Scope.Scope>,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const directory = Effect.fnUntraced(function* (name: string) {
    const target = path.join(yield* dataRoot, name);
    yield* fs.makeDirectory(target, { recursive: true });
    return target;
  });
  const config =
    kind === "database"
      ? { version: "17", jwtExpiry: 3600 }
      : kind === "storage" || kind === "imgproxy"
        ? { filePath: yield* directory("storage") }
        : kind === "functions"
          ? { functionsRoot: yield* directory("functions") }
          : {};
  const endpoints = Object.fromEntries(
    allowedEndpointNames(kind).map((name) => [name, { port: "auto" }]),
  );
  return { config, endpoints };
});

function byKind<K extends Kind>(
  members: ReadonlyArray<StackEffect.ServiceInstances[Kind]>,
): { readonly [P in K]: StackEffect.ServiceInstances[P] };
function byKind(
  members: ReadonlyArray<StackEffect.ServiceInstances[Kind]>,
): Readonly<Record<string, StackEffect.ServiceInstances[Kind]>> {
  return Object.fromEntries(members.map((member) => [member.service, member]));
}

const make = Effect.fn("TestStack.make")(
  function* <K extends Kind>(
    options: TestStackOptions<ReadonlyArray<TestService | PlainTestService>>,
    decode: (creation: unknown) => Effect.Effect<StackEffect.ServiceCreationInput, StackError>,
  ) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const crypto = yield* Crypto.Crypto;
    const runtime =
      options.runtime ?? Option.getOrUndefined(yield* runtimeOverride) ?? defaultRuntime();
    // Shared roots are created owner-only, so each OS user needs its own.
    const user = process.getuid?.() ?? userInfo().username;
    const stateRoot = options.stateRoot ?? path.join(tmpdir(), `supabase-stack-tests-${user}`);
    const cacheRoot = options.cacheRoot ?? path.join(tmpdir(), `supabase-stack-artifacts-${user}`);
    // Native Edge Runtime on Linux cannot read project files below /tmp.
    const temporaryRoot = fs.makeTempDirectoryScoped({
      prefix: "supabase-test-stack-",
      ...(runtime === "native" && process.platform === "linux" ? { directory: homedir() } : {}),
    });
    const projectRoot = options.projectRoot ?? (yield* temporaryRoot);
    const dataRoot =
      options.projectRoot === undefined
        ? Effect.succeed(projectRoot)
        : yield* Effect.cached(temporaryRoot);
    const services: ReadonlyArray<TestService | PlainTestService> = options.services ?? [
      "database",
    ];
    const creations = yield* Effect.forEach(services, (service) =>
      Effect.gen(function* () {
        const kind = typeof service === "string" ? service : service.service;
        const local = yield* localCreation(kind, dataRoot);
        return yield* decode({
          service: kind,
          config: { ...local.config, ...(typeof service === "string" ? {} : service.config) },
          endpoints: {
            ...local.endpoints,
            ...(typeof service === "string" ? {} : service.endpoints),
          },
        });
      }),
    );
    const stack = yield* Effect.acquireRelease(
      StackEffect.create({
        projectRoot,
        stateRoot,
        cacheRoot,
        runtime,
        name: `test-${yield* crypto.randomUUIDv4}`,
        lifetime: "session",
      }),
      (created) => created.destroy.pipe(Effect.orDie),
    );
    const diagnose = (operation: string) => (cause: StackError) =>
      stack.services.list.pipe(
        Effect.flatMap((registered) =>
          Effect.forEach(registered, (member) =>
            member.status.pipe(
              Effect.map(
                (status) =>
                  `${member.service}=${status.lifecycle}` +
                  `${status.health === undefined ? "" : `/${status.health}`}` +
                  `${status.error === undefined ? "" : ` (${status.error.message})`}`,
              ),
              Effect.orElseSucceed(() => `${member.service}=unobservable`),
            ),
          ),
        ),
        Effect.orElseSucceed((): ReadonlyArray<string> => []),
        Effect.flatMap((statuses) =>
          Effect.fail(
            new StackError({
              ...cause,
              operation,
              message: `${cause.message}\nServices: ${statuses.length === 0 ? "none" : statuses.join(", ")}\nOwner log: ${path.join(stateRoot, stack.id, "owner.log")}`,
            }),
          ),
        ),
      );
    const members = yield* stack.composition
      .supabase(creations, { eager: true })
      .pipe(Effect.catch(diagnose("test-startup")));
    const start = (operation: string) =>
      stack.composition.start.pipe(
        Effect.andThen(
          Effect.forEach(members, (member) => member.ready, {
            concurrency: "unbounded",
            discard: true,
          }),
        ),
        Effect.catch(diagnose(operation)),
      );
    yield* start("test-startup");
    const database = members.find(
      (member): member is StackEffect.DatabaseInstance => member.service === "database",
    );
    const checkpoints = yield* Ref.make<ReadonlySet<string>>(new Set());
    const withContext = (suffix: string) =>
      Effect.mapError(
        (failure: StackError) =>
          new StackError({ ...failure, message: `${failure.message}; ${suffix}` }),
      );
    /** Stops the composition around `work` and brings it back whether or not `work` succeeds. */
    const whileStopped = (
      operation: string,
      work: (database: StackEffect.DatabaseInstance) => Effect.Effect<void, StackError>,
    ) =>
      database === undefined
        ? Effect.fail(
            new StackError({ operation, message: "Test stack checkpoints require a database" }),
          )
        : stack.composition.stop.pipe(
            Effect.andThen(database.stop),
            Effect.andThen(work(database)),
            Effect.matchEffect({
              onSuccess: () => start(operation),
              onFailure: (failure) =>
                start(operation).pipe(
                  Effect.matchEffect({
                    onSuccess: () => Effect.fail(failure),
                    onFailure: (restart) =>
                      Effect.fail(failure).pipe(
                        withContext(`restarting the composition also failed: ${restart.message}`),
                      ),
                  }),
                ),
            }),
          );
    const testStack: EffectTestStack<K> = {
      stack,
      services: byKind<K>(members),
      projectRoot,
      checkpoint: (name) =>
        whileStopped("checkpoint", (current) =>
          current
            .saveSnapshot(name, { scope: "instance" })
            .pipe(Effect.andThen(Ref.update(checkpoints, (names) => new Set([...names, name])))),
        ),
      reset: (name) =>
        Ref.get(checkpoints).pipe(
          Effect.flatMap((names) =>
            names.has(name)
              ? whileStopped("reset", (current) =>
                  current.resetData.pipe(
                    withContext("the database data may have been partially reset"),
                    Effect.andThen(
                      current.restoreSnapshot(name, { scope: "instance" }).pipe(
                        Effect.flatMap((restored) =>
                          restored
                            ? Effect.void
                            : Effect.fail(
                                new StackError({
                                  operation: "reset",
                                  message: `Checkpoint ${name} is missing`,
                                }),
                              ),
                        ),
                        withContext(
                          `the database data was reset without restoring checkpoint ${name}`,
                        ),
                      ),
                    ),
                  ),
                )
              : Effect.fail(
                  new StackError({
                    operation: "reset",
                    message: `No checkpoint named ${name}; the database data was not reset`,
                  }),
                ),
          ),
        ),
    };
    return testStack;
  },
  Effect.mapError(testFailure("test-stack")),
);

const decodeCreation = (creation: unknown) =>
  Schema.decodeUnknownEffect(CreationSchema)(creation).pipe(Effect.mapError(testFailure("config")));
const creationJson = Schema.toCodecJson(CreationSchema);
const decodePlainCreation = (creation: unknown) =>
  Schema.decodeUnknownEffect(creationJson)(creation).pipe(Effect.mapError(testFailure("config")));

/** Creates, composes and readies a session stack that the enclosing scope destroys. */
export const makeTestStack = <const S extends ReadonlyArray<TestService> = readonly ["database"]>(
  options: TestStackOptions<S> = {},
) => make<TestServiceKind<S[number]>>(options, decodeCreation);

/** Creates, composes and readies a session stack for `await using`. */
export const createTestStack = <
  const S extends ReadonlyArray<PlainTestService> = readonly ["database"],
>(
  options: TestStackOptions<S> = {},
  callOptions?: CallOptions,
): Promise<TestStack<TestServiceKind<S[number]>>> =>
  acquire(make<TestServiceKind<S[number]>>(options, decodePlainCreation), callOptions).then(
    ({ value, client }) => {
      const adapter = stackAdapter(client);
      return {
        stack: adapter.stack(value.stack),
        services: adapter.services(value.services),
        projectRoot: value.projectRoot,
        checkpoint: (name, runOptions) => client.run(value.checkpoint(name), runOptions),
        reset: (name, runOptions) => client.run(value.reset(name), runOptions),
        [Symbol.asyncDispose]: client.close,
      };
    },
  );
