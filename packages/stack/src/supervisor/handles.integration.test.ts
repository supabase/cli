import { NodeServices } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import {
  Cause,
  Effect,
  Exit,
  FileSystem,
  Fiber,
  Option,
  Path,
  Result,
  Schema,
  Stream,
} from "effect";
import { ChildProcess } from "effect/unstable/process";
import {
  createStack,
  findStack,
  inspectStack,
  openStack,
  listStacks,
} from "../public/EffectStack.ts";
import { defaultRuntimeEnvironment, type StackRuntimeEnvironmentValue } from "./Launcher.ts";
import { StackIdSchema } from "../public/StackId.ts";
import type { StackId } from "../public/StackId.ts";
import { readOwnerMetadata, StackRuntimeEnvironment } from "../state/Ownership.ts";
import { makeControlClient } from "../control/ControlServer.ts";
import { resolveStackPaths } from "../state/Paths.ts";
import { STACK_RPC_RELEASE } from "../control/StackRpc.ts";
import {
  ContainerEngineError,
  StackRuntimeMismatchError,
  StackUpgradeRequiredError,
} from "../public/Errors.ts";
import { ContainerEngineProtocolError } from "../runtime/ContainerEngine.ts";
import { ContainerEngineResolver } from "../runtime/ContainerEngineResolver.ts";

const withRuntimeRoot = <A, E, R>(effect: (project: string) => Effect.Effect<A, E, R>) =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "supabase-stack-handles-" });
      const path = yield* Path.Path;
      const project = path.join(root, "project");
      yield* fs.makeDirectory(project);
      const defaults = defaultRuntimeEnvironment();
      const runtime: StackRuntimeEnvironmentValue = {
        ...defaults,
        stateRoot: path.join(root, "managed", "stacks"),
        tempRoot: "/tmp",
        platform: "posix",
      };
      const cleanupOwners = Effect.gen(function* () {
        const exists = yield* fs.exists(runtime.stateRoot);
        if (!exists) return;
        const entries = yield* fs.readDirectory(runtime.stateRoot);
        yield* Effect.forEach(
          entries,
          (entry) =>
            Schema.is(StackIdSchema)(entry) ? quiesceOwner(StackIdSchema.make(entry)) : Effect.void,
          { discard: true },
        );
      });
      return yield* effect(project).pipe(
        Effect.onExit(() => cleanupOwners),
        Effect.provideService(StackRuntimeEnvironment, runtime),
      );
    }),
  ).pipe(Effect.provide(NodeServices.layer));

const quiesceOwner = (id: StackId) =>
  Effect.gen(function* () {
    const env = yield* StackRuntimeEnvironment;
    const fs = yield* FileSystem.FileSystem;
    const paths = yield* resolveStackPaths({ stateRoot: env.stateRoot, stackId: id });
    const owner = yield* readOwnerMetadata(env.stateRoot, id, env);
    if (owner === undefined) return;
    const removed = Stream.runHead(
      Stream.filterMapEffect(fs.watch(paths.stackRoot), () =>
        readOwnerMetadata(env.stateRoot, id, env).pipe(
          Effect.map((metadata) =>
            metadata === undefined ? Result.succeed(true) : Result.fail(undefined),
          ),
        ),
      ),
    );
    const watcher = yield* Effect.forkChild(removed);
    yield* Effect.scoped(
      makeControlClient(owner.endpoint, {
        stackId: id,
        ownerSessionId: owner.ownerSessionId,
        rpcRelease: owner.rpcRelease,
      }).quiesce(),
    );
    const remaining = yield* readOwnerMetadata(env.stateRoot, id, env);
    if (remaining === undefined) {
      yield* Fiber.interrupt(watcher);
      return;
    }
    yield* Fiber.join(watcher);
  });

const quoteModuleSpecifier = (value: string): string =>
  `'${value.replaceAll("\\", "\\\\").replaceAll("'", "\\'")}'`;

describe("managed stack handles", () => {
  it.live("resolves a new automatic container identity and persists Docker", () =>
    withRuntimeRoot((project) =>
      Effect.gen(function* () {
        const calls: string[] = [];
        const resolver = {
          resolve: (preference: "auto" | "docker" | "podman") =>
            Effect.sync(() => {
              calls.push(preference);
              return "docker" as const;
            }),
        };
        const stack = yield* createStack({
          projectRoot: project,
          runtime: { kind: "container", engine: "auto" },
        }).pipe(Effect.provideService(ContainerEngineResolver, resolver));
        expect(calls).toEqual(["auto"]);
        expect(
          (yield* findStack({ projectRoot: project })).pipe(Option.getOrUndefined)?.runtime,
        ).toEqual({ kind: "container", engine: "docker" });
        yield* stack.close();
      }),
    ),
  );

  it.live("selects and persists Podman when the automatic resolver falls back", () =>
    withRuntimeRoot((project) =>
      Effect.gen(function* () {
        const calls: string[] = [];
        const resolver = {
          resolve: (preference: "auto" | "docker" | "podman") =>
            Effect.sync(() => {
              calls.push(preference);
              return "podman" as const;
            }),
        };
        const stack = yield* createStack({
          projectRoot: project,
          runtime: { kind: "container", engine: "auto" },
        }).pipe(Effect.provideService(ContainerEngineResolver, resolver));
        expect(calls).toEqual(["auto"]);
        expect(
          (yield* findStack({ projectRoot: project })).pipe(Option.getOrUndefined)?.runtime,
        ).toEqual({ kind: "container", engine: "podman" });
        yield* stack.close();
      }),
    ),
  );

  it.live("maps an automatic engine daemon failure and does not fall through in createStack", () =>
    withRuntimeRoot((project) =>
      Effect.gen(function* () {
        const calls: string[] = [];
        const resolver = {
          resolve: (preference: "auto" | "docker" | "podman") =>
            Effect.sync(() => {
              calls.push(preference);
            }).pipe(
              Effect.andThen(
                Effect.fail(
                  new ContainerEngineProtocolError({
                    operation: "probe",
                    message: "Docker daemon unavailable",
                  }),
                ),
              ),
            ),
        };
        const result = yield* createStack({
          projectRoot: project,
          runtime: { kind: "container", engine: "auto" },
        }).pipe(Effect.provideService(ContainerEngineResolver, resolver), Effect.exit);
        expect(Exit.isFailure(result)).toBe(true);
        if (Exit.isFailure(result)) {
          const error = Option.getOrUndefined(Cause.findErrorOption(result.cause));
          expect(error).toBeInstanceOf(ContainerEngineError);
        }
        expect(calls).toEqual(["auto"]);
      }),
    ),
  );

  it.live("probes only explicitly requested Podman", () =>
    withRuntimeRoot((project) =>
      Effect.gen(function* () {
        const calls: string[] = [];
        const resolver = {
          resolve: (preference: "auto" | "docker" | "podman") =>
            Effect.sync(() => {
              calls.push(preference);
              return "podman" as const;
            }),
        };
        const stack = yield* createStack({
          projectRoot: project,
          runtime: { kind: "container", engine: "podman" },
        }).pipe(Effect.provideService(ContainerEngineResolver, resolver));
        expect(calls).toEqual(["podman"]);
        yield* stack.close();
      }),
    ),
  );

  it.live("reuses a persisted engine for automatic create without probing again", () =>
    withRuntimeRoot((project) =>
      Effect.gen(function* () {
        const firstCalls: string[] = [];
        const firstResolver = {
          resolve: (preference: "auto" | "docker" | "podman") =>
            Effect.sync(() => {
              firstCalls.push(preference);
              return "podman" as const;
            }),
        };
        const first = yield* createStack({
          projectRoot: project,
          runtime: { kind: "container", engine: "podman" },
        }).pipe(Effect.provideService(ContainerEngineResolver, firstResolver));
        yield* first.close();
        const secondCalls: string[] = [];
        const secondResolver = {
          resolve: (preference: "auto" | "docker" | "podman") =>
            Effect.sync(() => {
              secondCalls.push(preference);
              return "docker" as const;
            }),
        };
        const second = yield* createStack({
          projectRoot: project,
          runtime: { kind: "container", engine: "auto" },
        }).pipe(Effect.provideService(ContainerEngineResolver, secondResolver));
        expect(firstCalls).toEqual(["podman"]);
        expect(secondCalls).toEqual([]);
        expect(
          (yield* findStack({ projectRoot: project })).pipe(Option.getOrUndefined)?.runtime,
        ).toEqual({ kind: "container", engine: "podman" });
        yield* second.close();
      }),
    ),
  );

  it.live("rejects a conflicting explicit engine before probing", () =>
    withRuntimeRoot((project) =>
      Effect.gen(function* () {
        const first = yield* createStack({
          projectRoot: project,
          runtime: { kind: "container", engine: "docker" },
        }).pipe(
          Effect.provideService(ContainerEngineResolver, {
            resolve: () => Effect.succeed("docker" as const),
          }),
        );
        yield* first.close();
        const calls: string[] = [];
        const result = yield* createStack({
          projectRoot: project,
          runtime: { kind: "container", engine: "podman" },
        }).pipe(
          Effect.provideService(ContainerEngineResolver, {
            resolve: (preference: "auto" | "docker" | "podman") =>
              Effect.sync(() => {
                calls.push(preference);
                return "podman" as const;
              }),
          }),
          Effect.exit,
        );
        expect(Exit.isFailure(result)).toBe(true);
        if (Exit.isFailure(result)) {
          const error = Option.getOrUndefined(Cause.findErrorOption(result.cause));
          expect(error).toBeInstanceOf(StackRuntimeMismatchError);
        }
        expect(calls).toEqual([]);
      }),
    ),
  );

  it.live("does not probe an explicitly native identity", () =>
    withRuntimeRoot((project) =>
      Effect.gen(function* () {
        const calls: string[] = [];
        const stack = yield* createStack({
          projectRoot: project,
          runtime: { kind: "native" },
        }).pipe(
          Effect.provideService(ContainerEngineResolver, {
            resolve: (preference: "auto" | "docker" | "podman") =>
              Effect.sync(() => {
                calls.push(preference);
                return "docker" as const;
              }),
          }),
        );
        expect(calls).toEqual([]);
        yield* stack.close();
      }),
    ),
  );

  it.live("creates an unconfigured stack without reading config or starting workloads", () =>
    withRuntimeRoot((project) =>
      Effect.gen(function* () {
        const stack = yield* createStack({ projectRoot: project });
        const status = yield* stack.status();
        expect(status.lifecycle).toBe("unconfigured");
        expect(status.desiredLifecycle).toBe("unconfigured");
        yield* stack.close();
      }),
    ),
  );

  it.live("concurrent equivalent creates join one owner", () =>
    withRuntimeRoot((project) =>
      Effect.gen(function* () {
        const [first, second] = yield* Effect.all(
          [createStack({ projectRoot: project }), createStack({ projectRoot: project })],
          { concurrency: 2 },
        );
        expect(second.id).toBe(first.id);
        expect((yield* second.status()).lifecycle).toBe("unconfigured");
        yield* first.close();
        yield* second.close();
      }),
    ),
  );

  it.live("discovery never creates an identity", () =>
    withRuntimeRoot((project) =>
      Effect.gen(function* () {
        const found = yield* findStack({ projectRoot: project });
        expect(Option.isNone(found)).toBe(true);
        const absentId = StackIdSchema.make("f".repeat(64));
        const absent = yield* inspectStack(absentId).pipe(Effect.exit);
        expect(Exit.isFailure(absent)).toBe(true);
      }),
    ),
  );

  it.live("openStack is observational and rejects unknown ids", () =>
    withRuntimeRoot((_project) =>
      Effect.gen(function* () {
        const result = yield* openStack(StackIdSchema.make("0".repeat(64))).pipe(Effect.exit);
        expect(Exit.isFailure(result)).toBe(true);
      }),
    ),
  );

  it.live("a closed handle leaves its owner available to a replacement handle", () =>
    withRuntimeRoot((project) =>
      Effect.gen(function* () {
        const first = yield* createStack({ projectRoot: project });
        const id = first.id;
        yield* first.close();
        const second = yield* openStack(id);
        expect((yield* second.status()).lifecycle).toBe("unconfigured");
        yield* second.close();
      }),
    ),
  );

  it.live("rejects an incompatible owner release without replacing the owner", () =>
    withRuntimeRoot((project) =>
      Effect.gen(function* () {
        const stack = yield* createStack({ projectRoot: project });
        const env = yield* StackRuntimeEnvironment;
        const fs = yield* FileSystem.FileSystem;
        const paths = yield* resolveStackPaths({ stateRoot: env.stateRoot, stackId: stack.id });
        const metadata = yield* readOwnerMetadata(env.stateRoot, stack.id, env);
        expect(metadata).not.toBeUndefined();
        const current = yield* fs.readFileString(paths.controlMetadata);
        yield* fs.writeFileString(
          paths.controlMetadata,
          current.replace(STACK_RPC_RELEASE, "stack-rpc-v0@0.0.1"),
        );
        const opened = yield* openStack(stack.id).pipe(Effect.exit);
        expect(Exit.isFailure(opened)).toBe(true);
        if (Exit.isFailure(opened)) {
          const error = Option.getOrUndefined(Cause.findErrorOption(opened.cause));
          expect(error).toBeInstanceOf(StackUpgradeRequiredError);
        }
        const recreated = yield* createStack({ projectRoot: project }).pipe(Effect.exit);
        expect(Exit.isFailure(recreated)).toBe(true);
        if (Exit.isFailure(recreated)) {
          const error = Option.getOrUndefined(Cause.findErrorOption(recreated.cause));
          expect(error).toBeInstanceOf(StackUpgradeRequiredError);
        }
        const inspected = yield* inspectStack(stack.id);
        expect(inspected.owner).toBe("incompatible");
        yield* stack.close();
      }),
    ),
  );

  it.live("filters read-only discovery by project root", () =>
    withRuntimeRoot((project) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const other = path.join(path.dirname(project), "other-project");
        yield* fs.makeDirectory(other);
        const first = yield* createStack({ projectRoot: project });
        const second = yield* createStack({ projectRoot: other });
        const filtered = yield* listStacks({ projectRoot: project });
        expect(filtered.map((entry) => entry.id)).toEqual([first.id]);
        yield* first.close();
        yield* second.close();
      }),
    ),
  );

  it.live("keeps the detached owner alive after concurrent caller processes exit", () =>
    withRuntimeRoot((project) =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const supabaseHome = path.dirname(project);
        const stackModule = new URL("../public/EffectStack.ts", import.meta.url).href;
        const encodedStackModule = quoteModuleSpecifier(stackModule);
        const script = `
          const { Effect } = await import("effect");
          const { NodeServices } = await import("@effect/platform-node");
          const { createStack } = await import(${encodedStackModule});
          const stack = await Effect.runPromise(Effect.scoped(createStack({ projectRoot: process.argv[1] }).pipe(Effect.provide(NodeServices.layer))));
          process.stdout.write(stack.id);
        `;
        const spawnCaller = () =>
          Effect.gen(function* () {
            const child = yield* ChildProcess.make(
              process.execPath,
              ["--input-type=module", "-e", script, project],
              {
                cwd: process.cwd(),
                env: { SUPABASE_HOME: supabaseHome },
                extendEnv: true,
                stdout: "pipe",
                stderr: "pipe",
              },
            );
            const [chunks, stderrChunks, code] = yield* Effect.all(
              [Stream.runCollect(child.stdout), Stream.runCollect(child.stderr), child.exitCode],
              { concurrency: 3 },
            );
            const bytes = new Uint8Array(chunks.reduce((sum, value) => sum + value.byteLength, 0));
            let offset = 0;
            for (const value of chunks) {
              bytes.set(value, offset);
              offset += value.byteLength;
            }
            const stderr = new TextDecoder().decode(
              new Uint8Array(stderrChunks.reduce((sum, value) => sum + value.byteLength, 0)),
            );
            return { id: new TextDecoder().decode(bytes), code, stderr };
          });
        const [first, second] = yield* Effect.all([spawnCaller(), spawnCaller()], {
          concurrency: 2,
        });
        expect(first.code, first.stderr).toBe(0);
        expect(second.code, second.stderr).toBe(0);
        expect(first.id).toBe(second.id);
        const attached = yield* openStack(StackIdSchema.make(first.id));
        expect((yield* attached.status()).lifecycle).toBe("unconfigured");
        yield* attached.close();
      }),
    ),
  );

  it.live(
    "maintenance stop keeps an unconfigured owner usable without fabricating lifecycle state",
    () =>
      withRuntimeRoot((project) =>
        Effect.gen(function* () {
          const stack = yield* createStack({ projectRoot: project });
          yield* stack.stop();
          const status = yield* stack.status();
          expect(status.lifecycle).toBe("unconfigured");
          yield* stack.close();
        }),
      ),
  );
});
