import { describe, expect, it } from "@effect/vitest";
import { ConfigProvider, Effect, Layer, Sink, Stream } from "effect";
import { FileSystem } from "effect";
import { ChildProcessSpawner } from "effect/unstable/process";
import { mockRuntimeInfo } from "../../tests/helpers/mocks.ts";
import { Browser } from "./browser.service.ts";
import { browserLayer } from "./browser.layer.ts";

type SpawnedCommand = { command: string; args: readonly string[] };

function mockSpawner() {
  const spawned: SpawnedCommand[] = [];
  const layer = Layer.succeed(
    ChildProcessSpawner.ChildProcessSpawner,
    ChildProcessSpawner.make((command: any) =>
      Effect.sync(() => {
        const cmd = command as { _tag: string; command: string; args: readonly string[] };
        spawned.push({ command: cmd.command, args: cmd.args });
        return ChildProcessSpawner.makeHandle({
          pid: ChildProcessSpawner.ProcessId(1),
          exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(0)),
          isRunning: Effect.succeed(false),
          kill: () => Effect.void,
          stdin: Sink.drain as any,
          stdout: Stream.empty,
          stderr: Stream.empty,
          all: Stream.empty,
          getInputFd: () => Sink.drain as any,
          getOutputFd: () => Stream.empty,
        });
      }),
    ),
  );
  return { layer, spawned };
}

function mockFs(opts: { osreleaseExists?: boolean; osreleaseContent?: string } = {}) {
  return Layer.succeed(FileSystem.FileSystem, {
    exists: (path: string) =>
      Effect.succeed(opts.osreleaseExists === true && path === "/proc/sys/kernel/osrelease"),
    readFileString: (_path: string) => Effect.succeed(opts.osreleaseContent ?? ""),
  } as any);
}

function makeBrowserLayer(
  spawner: ReturnType<typeof mockSpawner>,
  fs: Layer.Layer<FileSystem.FileSystem>,
  platform: NodeJS.Platform,
  env: Record<string, string> = {},
) {
  const configLayer = ConfigProvider.layer(ConfigProvider.fromEnv({ env }));
  return Layer.mergeAll(
    browserLayer.pipe(
      Layer.provide(Layer.mergeAll(spawner.layer, fs, configLayer, mockRuntimeInfo({ platform }))),
    ),
    configLayer,
  );
}

describe("Browser", () => {
  it.effect("macOS: spawns 'open' with URL", () => {
    const spawner = mockSpawner();
    const layer = makeBrowserLayer(spawner, mockFs(), "darwin");
    return Effect.gen(function* () {
      const { open } = yield* Browser;
      yield* open("https://example.com");
      expect(spawner.spawned).toHaveLength(1);
      expect(spawner.spawned[0]!.command).toBe("open");
      expect(spawner.spawned[0]!.args).toEqual(["https://example.com"]);
    }).pipe(Effect.provide(layer));
  });

  it.effect("Windows: spawns rundll32.exe with SYSTEMROOT", () => {
    const spawner = mockSpawner();
    const layer = makeBrowserLayer(spawner, mockFs(), "win32", { SYSTEMROOT: "D:\\Windows" });
    return Effect.gen(function* () {
      const { open } = yield* Browser;
      yield* open("https://example.com");
      expect(spawner.spawned).toHaveLength(1);
      expect(spawner.spawned[0]!.command).toBe("D:\\Windows\\System32\\rundll32.exe");
      expect(spawner.spawned[0]!.args).toEqual([
        "url.dll,FileProtocolHandler",
        "https://example.com",
      ]);
    }).pipe(Effect.provide(layer));
  });

  it.effect("Windows: uses C:\\Windows when SYSTEMROOT unset", () => {
    const spawner = mockSpawner();
    const layer = makeBrowserLayer(spawner, mockFs(), "win32");
    return Effect.gen(function* () {
      const { open } = yield* Browser;
      yield* open("https://example.com");
      expect(spawner.spawned[0]!.command).toBe("C:\\Windows\\System32\\rundll32.exe");
    }).pipe(Effect.provide(layer));
  });

  it.effect("Linux non-WSL: spawns xdg-open when osrelease file missing", () => {
    const spawner = mockSpawner();
    const layer = makeBrowserLayer(spawner, mockFs({ osreleaseExists: false }), "linux");
    return Effect.gen(function* () {
      const { open } = yield* Browser;
      yield* open("https://example.com");
      expect(spawner.spawned[0]!.command).toBe("xdg-open");
      expect(spawner.spawned[0]!.args).toEqual(["https://example.com"]);
    }).pipe(Effect.provide(layer));
  });

  it.effect("Linux non-WSL: spawns xdg-open when osrelease has no microsoft", () => {
    const spawner = mockSpawner();
    const layer = makeBrowserLayer(
      spawner,
      mockFs({ osreleaseExists: true, osreleaseContent: "5.15.0-generic" }),
      "linux",
    );
    return Effect.gen(function* () {
      const { open } = yield* Browser;
      yield* open("https://example.com");
      expect(spawner.spawned[0]!.command).toBe("xdg-open");
    }).pipe(Effect.provide(layer));
  });

  it.effect("WSL: spawns wslview when osrelease contains microsoft", () => {
    const spawner = mockSpawner();
    const layer = makeBrowserLayer(
      spawner,
      mockFs({
        osreleaseExists: true,
        osreleaseContent: "5.15.146.1-microsoft-standard-WSL2",
      }),
      "linux",
    );
    return Effect.gen(function* () {
      const { open } = yield* Browser;
      yield* open("https://example.com");
      expect(spawner.spawned[0]!.command).toBe("wslview");
      expect(spawner.spawned[0]!.args).toEqual(["https://example.com"]);
    }).pipe(Effect.provide(layer));
  });

  it.effect("errors are ignored when spawner fails", () => {
    const failingLayer = Layer.succeed(
      ChildProcessSpawner.ChildProcessSpawner,
      ChildProcessSpawner.make(() => Effect.fail(new Error("spawn failed") as any)),
    );
    const configLayer = ConfigProvider.layer(ConfigProvider.fromEnv({ env: {} }));
    const layer = Layer.mergeAll(
      browserLayer.pipe(
        Layer.provide(
          Layer.mergeAll(
            failingLayer,
            mockFs(),
            configLayer,
            mockRuntimeInfo({ platform: "darwin" }),
          ),
        ),
      ),
      configLayer,
    );
    return Effect.gen(function* () {
      const { open } = yield* Browser;
      yield* open("https://example.com");
    }).pipe(Effect.provide(layer));
  });
});
