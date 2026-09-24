import { NodeServices } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import { Cause, Effect, Exit, Fiber, Layer, Option, Sink, Stream } from "effect";
import { TestClock } from "effect/testing";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { makeContainerRuntime } from "./Container.ts";

const primary = "ghcr.io/supabase/cli/postgrest:v16.2";
const mirror = "public.ecr.aws/supabase/cli/postgrest:v16.2";
const secondMirror = "registry.test/supabase/cli/postgrest:v16.2";

/**
 * Docker stand-in: `image inspect` reports `local`, `pull` is rate-limited for the counted
 * `throttled` attempts and then succeeds for `pullable`, `create` refuses.
 */
const fakeEngine = (options: {
  readonly pullable: ReadonlyArray<string>;
  readonly throttled?: Readonly<Record<string, number>>;
}) => {
  const pullable = new Set(options.pullable);
  const throttled = new Map(Object.entries(options.throttled ?? {}));
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
      const remaining = throttled.get(ref) ?? 0;
      if (remaining > 0) {
        throttled.set(ref, remaining - 1);
        return Effect.succeed(handle(1, "", "toomanyrequests: Rate exceeded"));
      }
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

  it.live("reports the primary pull failure, then each mirror's, when every mirror fails", () => {
    const engine = fakeEngine({ pullable: [] });
    return Effect.gen(function* () {
      const runtime = yield* makeContainerRuntime({
        engine: "docker",
        imageMirrors: (image) => (image === primary ? [mirror, secondMirror] : []),
      });
      const failed = yield* runtime.prepare(primary).pipe(Effect.exit);
      const error = Exit.isFailure(failed)
        ? Option.getOrUndefined(Cause.findErrorOption(failed.cause))
        : undefined;
      expect(error?.message.split("\n")).toEqual([
        `denied: ${primary}`,
        `Mirror ${mirror} also failed: denied: ${mirror}`,
        `Mirror ${secondMirror} also failed: denied: ${secondMirror}`,
      ]);
      yield* launchImage(runtime);
      expect(engine.commands.find((args) => args[0] === "create")?.at(-1)).toBe(primary);
    }).pipe(Effect.provide(Layer.merge(NodeServices.layer, engine.layer)));
  });

  it.live("never contacts the mirror when the primary pull succeeds", () => {
    const engine = fakeEngine({ pullable: [primary, mirror] });
    return Effect.gen(function* () {
      const runtime = yield* makeContainerRuntime({
        engine: "docker",
        imageMirrors: (image) => (image === primary ? [mirror] : []),
      });
      yield* runtime.prepare(primary);
      yield* launchImage(runtime);
      expect(engine.commands.flat()).not.toContain(mirror);
    }).pipe(Effect.provide(Layer.merge(NodeServices.layer, engine.layer)));
  });

  it.effect("retries a rate-limited pull with backoff until the registry accepts it", () => {
    const engine = fakeEngine({ pullable: [primary], throttled: { [primary]: 2 } });
    return Effect.gen(function* () {
      const runtime = yield* makeContainerRuntime({ engine: "docker" });
      const prepared = yield* runtime.prepare(primary).pipe(Effect.forkChild);
      yield* TestClock.adjust("1 minute");
      yield* Fiber.join(prepared);
      expect(engine.commands.filter((args) => args[0] === "pull")).toHaveLength(3);
      expect(engine.local.has(primary)).toBe(true);
    }).pipe(Effect.provide(Layer.merge(NodeServices.layer, engine.layer)));
  });

  it.effect("reports the rate limit after five throttled attempts", () => {
    const engine = fakeEngine({ pullable: [primary], throttled: { [primary]: 10 } });
    return Effect.gen(function* () {
      const runtime = yield* makeContainerRuntime({ engine: "docker" });
      const prepared = yield* runtime.prepare(primary).pipe(Effect.exit, Effect.forkChild);
      yield* TestClock.adjust("5 minutes");
      const failed = yield* Fiber.join(prepared);
      const error = Exit.isFailure(failed)
        ? Option.getOrUndefined(Cause.findErrorOption(failed.cause))
        : undefined;
      expect(error?.message).toContain("toomanyrequests");
      expect(engine.commands.filter((args) => args[0] === "pull")).toHaveLength(5);
    }).pipe(Effect.provide(Layer.merge(NodeServices.layer, engine.layer)));
  });

  it.effect("stops pulling once a concurrent prepare lands the image during backoff", () => {
    const engine = fakeEngine({ pullable: [primary], throttled: { [primary]: 1 } });
    return Effect.gen(function* () {
      const runtime = yield* makeContainerRuntime({ engine: "docker" });
      const throttled = yield* runtime.prepare(primary).pipe(Effect.forkChild);
      yield* TestClock.adjust("1 millis");
      yield* runtime.prepare(primary);
      yield* TestClock.adjust("1 minute");
      yield* Fiber.join(throttled);
      expect(engine.commands.filter((args) => args[0] === "pull")).toHaveLength(2);
    }).pipe(Effect.provide(Layer.merge(NodeServices.layer, engine.layer)));
  });

  it.effect(
    "retries the chain when the primary is unreachable and the mirror is rate-limited",
    () => {
      const engine = fakeEngine({ pullable: [mirror], throttled: { [mirror]: 1 } });
      return Effect.gen(function* () {
        const runtime = yield* makeContainerRuntime({
          engine: "docker",
          imageMirrors: (image) => (image === primary ? [mirror] : []),
        });
        const prepared = yield* runtime.prepare(primary).pipe(Effect.forkChild);
        yield* TestClock.adjust("1 minute");
        yield* Fiber.join(prepared);
        expect(engine.commands.filter((args) => args[0] === "pull")).toEqual([
          ["pull", primary],
          ["pull", mirror],
          ["pull", primary],
          ["pull", mirror],
        ]);
      }).pipe(Effect.provide(Layer.merge(NodeServices.layer, engine.layer)));
    },
  );

  it.effect("falls back to a mirror before backing off on a rate-limited primary", () => {
    const engine = fakeEngine({ pullable: [mirror], throttled: { [primary]: 10 } });
    return Effect.gen(function* () {
      const runtime = yield* makeContainerRuntime({
        engine: "docker",
        imageMirrors: (image) => (image === primary ? [mirror] : []),
      });
      yield* runtime.prepare(primary);
      expect(engine.commands.filter((args) => args[0] === "pull")).toEqual([
        ["pull", primary],
        ["pull", mirror],
      ]);
    }).pipe(Effect.provide(Layer.merge(NodeServices.layer, engine.layer)));
  });
});
