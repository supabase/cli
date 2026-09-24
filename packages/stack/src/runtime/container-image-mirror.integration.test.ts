import { NodeServices } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import { Cause, Effect, Exit, Layer, Option, Sink, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { makeContainerRuntime } from "./Container.ts";

const primary = "ghcr.io/supabase/cli/postgrest:v16.2";
const mirror = "public.ecr.aws/supabase/cli/postgrest:v16.2";
const secondMirror = "registry.test/supabase/cli/postgrest:v16.2";

/** Docker stand-in: `image inspect` reports `local`, `pull` succeeds for `pullable`, `create` refuses. */
const fakeEngine = (options: { readonly pullable: ReadonlyArray<string> }) => {
  const pullable = new Set(options.pullable);
  const local = new Set<string>();
  const commands: string[][] = [];
  const handle = (exitCode: number, stdout = "", stderr = "") =>
    ChildProcessSpawner.makeHandle({
      pid: ChildProcessSpawner.ProcessId(4242),
      exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(exitCode)),
      isRunning: Effect.succeed(false),
      kill: () => Effect.void,
      stdin: Sink.drain,
      stdout: Stream.succeed(new TextEncoder().encode(stdout)),
      stderr: Stream.succeed(new TextEncoder().encode(stderr)),
      all: Stream.empty,
      getInputFd: () => Sink.drain,
      getOutputFd: () => Stream.empty,
      unref: Effect.succeed(Effect.void),
    });
  const spawner = ChildProcessSpawner.make((command) => {
    if (!ChildProcess.isStandardCommand(command)) return Effect.die("unexpected piped command");
    const args = [...command.args];
    commands.push(args);
    const ref = args.at(-1) ?? "";
    if (args[0] === "image") return Effect.succeed(handle(0, local.has(ref) ? "sha256:1" : ""));
    if (args[0] === "pull") {
      if (!pullable.has(ref)) return Effect.succeed(handle(1, "", `denied: ${ref}`));
      local.add(ref);
      return Effect.succeed(handle(0));
    }
    return Effect.succeed(handle(1, "", "create refused"));
  });
  return {
    commands,
    pullable,
    local,
    layer: Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner),
  };
};

const launchImage = (runtime: Effect.Success<ReturnType<typeof makeContainerRuntime>>) =>
  Effect.scoped(
    runtime.launch({ image: primary, stackId: "a".repeat(64), instanceId: "mirror", env: {} }),
  ).pipe(Effect.exit);

describe("container image mirror", () => {
  it.live("pulls and launches the mirror image when the primary pull fails", () => {
    const engine = fakeEngine({ pullable: [mirror] });
    return Effect.gen(function* () {
      const runtime = yield* makeContainerRuntime({
        engine: "docker",
        root: ".",
        imageMirrors: (image) => (image === primary ? [mirror] : []),
      });
      yield* runtime.prepare(primary);
      yield* launchImage(runtime);
      expect(engine.commands.filter((args) => args[0] === "pull")).toEqual([
        ["pull", primary],
        ["pull", mirror],
      ]);
      expect(engine.commands.find((args) => args[0] === "create")?.at(-1)).toBe(mirror);
    }).pipe(Effect.provide(Layer.merge(NodeServices.layer, engine.layer)));
  });

  it.live("tries each mirror in order until one pull succeeds", () => {
    const engine = fakeEngine({ pullable: [secondMirror] });
    return Effect.gen(function* () {
      const runtime = yield* makeContainerRuntime({
        engine: "docker",
        root: ".",
        imageMirrors: (image) => (image === primary ? [mirror, secondMirror] : []),
      });
      yield* runtime.prepare(primary);
      yield* launchImage(runtime);
      expect(engine.commands.filter((args) => args[0] === "pull")).toEqual([
        ["pull", primary],
        ["pull", mirror],
        ["pull", secondMirror],
      ]);
      expect(engine.commands.find((args) => args[0] === "create")?.at(-1)).toBe(secondMirror);
    }).pipe(Effect.provide(Layer.merge(NodeServices.layer, engine.layer)));
  });

  it.live("launches the primary again once it pulls after an earlier mirror rescue", () => {
    const engine = fakeEngine({ pullable: [mirror] });
    return Effect.gen(function* () {
      const runtime = yield* makeContainerRuntime({
        engine: "docker",
        root: ".",
        imageMirrors: (image) => (image === primary ? [mirror] : []),
      });
      yield* runtime.prepare(primary);
      engine.local.delete(mirror);
      engine.pullable.add(primary);
      yield* runtime.prepare(primary);
      yield* launchImage(runtime);
      expect(engine.commands.find((args) => args[0] === "create")?.at(-1)).toBe(primary);
    }).pipe(Effect.provide(Layer.merge(NodeServices.layer, engine.layer)));
  });

  it.live("launches the primary again once it is present after an earlier mirror rescue", () => {
    const engine = fakeEngine({ pullable: [mirror] });
    return Effect.gen(function* () {
      const runtime = yield* makeContainerRuntime({
        engine: "docker",
        root: ".",
        imageMirrors: (image) => (image === primary ? [mirror] : []),
      });
      yield* runtime.prepare(primary);
      engine.local.delete(mirror);
      engine.local.add(primary);
      yield* runtime.prepare(primary);
      yield* launchImage(runtime);
      expect(engine.commands.find((args) => args[0] === "create")?.at(-1)).toBe(primary);
    }).pipe(Effect.provide(Layer.merge(NodeServices.layer, engine.layer)));
  });

  it.live("reports the primary pull failure when the mirror also fails", () => {
    const engine = fakeEngine({ pullable: [] });
    return Effect.gen(function* () {
      const runtime = yield* makeContainerRuntime({
        engine: "docker",
        root: ".",
        imageMirrors: (image) => (image === primary ? [mirror] : []),
      });
      const failed = yield* runtime.prepare(primary).pipe(Effect.exit);
      const error = Exit.isFailure(failed)
        ? Option.getOrUndefined(Cause.findErrorOption(failed.cause))
        : undefined;
      expect(error?.message).toContain(`denied: ${primary}`);
      yield* launchImage(runtime);
      expect(engine.commands.find((args) => args[0] === "create")?.at(-1)).toBe(primary);
    }).pipe(Effect.provide(Layer.merge(NodeServices.layer, engine.layer)));
  });

  it.live("never contacts the mirror when the primary pull succeeds", () => {
    const engine = fakeEngine({ pullable: [primary, mirror] });
    return Effect.gen(function* () {
      const runtime = yield* makeContainerRuntime({
        engine: "docker",
        root: ".",
        imageMirrors: (image) => (image === primary ? [mirror] : []),
      });
      yield* runtime.prepare(primary);
      yield* launchImage(runtime);
      expect(engine.commands.flat()).not.toContain(mirror);
    }).pipe(Effect.provide(Layer.merge(NodeServices.layer, engine.layer)));
  });
});
