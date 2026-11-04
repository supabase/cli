import process from "node:process";
import { connect } from "node:net";
import { BunServices } from "@effect/platform-bun";
import { expect, it } from "@effect/vitest";
import {
  Deferred,
  Effect,
  Fiber,
  FileSystem,
  Layer,
  PlatformError,
  Schema,
  Sink,
  Stream,
} from "effect";
import { TestClock } from "effect/testing";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { mockRuntimeInfo } from "../../../tests/helpers/mocks.ts";
import { LogsClipboard, logsClipboardLayer } from "./logs.clipboard.ts";

const encodeScriptString = Schema.encodeSync(Schema.fromJsonString(Schema.String));
const payload = JSON.stringify(
  { message: "你好\nquote ' $(not a command)", metadata: { id: "full-record" } },
  null,
  2,
);

const adapter = (
  platform: NodeJS.Platform,
  exits: ReadonlyArray<number | "missing" | "pending">,
) => {
  const started = Deferred.makeUnsafe<void>();
  const stopped = Deferred.makeUnsafe<void>();
  const commands: Array<{
    name: string;
    args: ChildProcess.StandardCommand["args"];
    text: string;
    options: ChildProcess.CommandOptions;
  }> = [];
  const spawner = ChildProcessSpawner.make((command) =>
    Effect.gen(function* () {
      if (command._tag !== "StandardCommand") return yield* Effect.die("Unexpected pipe");
      const input = command.options.stdin;
      if (!Stream.isStream(input)) return yield* Effect.die("Expected stdin stream");
      const chunks = yield* Stream.runCollect(input);
      commands.push({
        name: command.command,
        args: command.args,
        text: chunks.map((chunk) => new TextDecoder().decode(chunk)).join(""),
        options: command.options,
      });
      const code = exits[commands.length - 1] ?? 0;
      if (code === "missing")
        return yield* PlatformError.systemError({
          _tag: "NotFound",
          module: "ChildProcess",
          method: "spawn",
        });
      return yield* Effect.acquireRelease(
        Effect.succeed(
          ChildProcessSpawner.makeHandle({
            pid: ChildProcessSpawner.ProcessId(1),
            exitCode:
              code === "pending"
                ? Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never))
                : Effect.succeed(ChildProcessSpawner.ExitCode(code)),
            isRunning: Effect.succeed(false),
            stdin: Sink.drain,
            stdout: Stream.empty,
            stderr: Stream.empty,
            all: Stream.empty,
            kill: () => Effect.void,
            unref: Effect.succeed(Effect.void),
            getInputFd: () => Sink.drain,
            getOutputFd: () => Stream.empty,
          }),
        ),
        () => Deferred.succeed(stopped, undefined),
      );
    }),
  );
  const layer = logsClipboardLayer.pipe(
    Layer.provide(
      Layer.mergeAll(
        mockRuntimeInfo({ platform }),
        Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner),
      ),
    ),
  );
  return { commands, layer, started, stopped };
};

const platforms: ReadonlyArray<{ platform: NodeJS.Platform; name: string }> = [
  { platform: "darwin", name: "pbcopy" },
  { platform: "win32", name: "powershell.exe" },
  { platform: "linux", name: "wl-copy" },
];
it.effect.each(platforms)(
  "writes UTF-8 payload only through stdin on $platform",
  ({ platform, name }) =>
    Effect.gen(function* () {
      const test = adapter(platform, [0]);
      yield* LogsClipboard.use((clipboard) => clipboard.copy(payload)).pipe(
        Effect.provide(test.layer),
      );
      expect(test.commands).toHaveLength(1);
      expect(test.commands[0]?.name).toBe(name);
      expect(test.commands[0]?.text).toBe(payload);
      expect(test.commands[0]?.args.join(" ")).not.toContain("full-record");
      expect(test.commands[0]?.options.stdout).toBe("ignore");
      expect(test.commands[0]?.options.stderr).toBe("ignore");
      expect(test.commands[0]?.options.shell).not.toBe(true);
      if (platform === "win32") {
        expect(test.commands[0]?.args).toContain("-STA");
        expect(test.commands[0]?.args.join(" ")).toContain("$ErrorActionPreference='Stop'");
        expect(test.commands[0]?.args.join(" ")).toContain("ReadToEnd()");
      }
      if (platform === "darwin")
        expect(test.commands[0]?.options.env).toMatchObject({ LC_ALL: "en_US.UTF-8" });
    }),
);

it.effect("falls back from unavailable Wayland to X11 and requires a successful native exit", () =>
  Effect.gen(function* () {
    const success = adapter("linux", ["missing", 0]);
    yield* LogsClipboard.use((clipboard) => clipboard.copy(payload)).pipe(
      Effect.provide(success.layer),
    );
    expect(success.commands.map((command) => command.name)).toEqual(["wl-copy", "xclip"]);
    expect(success.commands[1]?.args).toEqual(["-selection", "clipboard", "-in"]);
    expect(success.commands[1]?.text).toBe(payload);
    const failure = adapter("darwin", [1]);
    const error = yield* LogsClipboard.use((clipboard) => clipboard.copy(payload)).pipe(
      Effect.provide(failure.layer),
      Effect.flip,
    );
    expect(error.reason).toBe("failed");
    expect(error.message).not.toContain("full-record");
    const missing = adapter("linux", ["missing", "missing", "missing"]);
    const unavailable = yield* LogsClipboard.use((clipboard) => clipboard.copy(payload)).pipe(
      Effect.provide(missing.layer),
      Effect.flip,
    );
    expect(unavailable.reason).toBe("unavailable");
    expect(unavailable.message).toContain("Install wl-clipboard");
  }),
);

it.live.skipIf(process.platform === "win32")(
  "keeps a background clipboard owner alive after its helper exits successfully",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "clipboard-owner-" });
      const socket = `${root}/owner.sock`;
      const pidFile = `${root}/owner.pid`;
      const real = yield* ChildProcessSpawner.ChildProcessSpawner;
      const owner = `const net=require('node:net'); const server=net.createServer(socket=>socket.on('data',()=>socket.write('clipboard owner alive'))); server.listen(${encodeScriptString(socket)},()=>process.send({pid:process.pid}));`;
      const leader = `const {spawn}=require('node:child_process'); const fs=require('node:fs'); process.stdin.resume(); const owner=spawn(process.execPath,['-e',${encodeScriptString(owner)}],{stdio:['ignore','ignore','ignore','ipc']}); owner.once('message',({pid})=>{fs.writeFileSync(${encodeScriptString(pidFile)},String(pid));process.exit(0)}); owner.once('error',()=>process.exit(1));`;
      let witnessed = false;
      yield* Effect.addFinalizer(() =>
        witnessed
          ? Effect.void
          : fs.readFileString(pidFile).pipe(
              Effect.flatMap((text) =>
                Effect.sync(() => {
                  try {
                    process.kill(Number(text), "SIGKILL");
                  } catch {}
                }),
              ),
              Effect.ignore,
            ),
      );
      const proxy = ChildProcessSpawner.make((command) =>
        command._tag === "StandardCommand"
          ? real.spawn(ChildProcess.make(process.execPath, ["-e", leader], command.options))
          : Effect.die("Unexpected clipboard pipeline"),
      );
      const layer = logsClipboardLayer.pipe(
        Layer.provide(
          Layer.mergeAll(
            mockRuntimeInfo({ platform: "linux" }),
            Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, proxy),
          ),
        ),
      );
      yield* LogsClipboard.use((clipboard) => clipboard.copy(payload)).pipe(Effect.provide(layer));
      const ownerPid = Number(yield* fs.readFileString(pidFile));
      const closed = yield* Deferred.make<void>();
      const received = yield* Deferred.make<string>();
      yield* Effect.acquireRelease(
        Effect.sync(() => {
          const client = connect(socket);
          let reply = "";
          client.once("close", () => {
            Deferred.doneUnsafe(closed, Effect.void);
          });
          client.once("error", (error) => {
            Deferred.doneUnsafe(received, Effect.die(error));
          });
          client.once("connect", () => client.write("ping"));
          client.on("data", (bytes) => {
            reply += bytes.toString();
            if (reply === "clipboard owner alive")
              Deferred.doneUnsafe(received, Effect.succeed(reply));
          });
          witnessed = true;
          return client;
        }),
        (client) =>
          Effect.sync(() => {
            try {
              process.kill(ownerPid, "SIGKILL");
            } catch {}
          }).pipe(
            Effect.andThen(Deferred.await(closed).pipe(Effect.timeout("2 seconds"), Effect.orDie)),
            Effect.ensuring(
              Effect.sync(() => {
                client.destroy();
              }),
            ),
          ),
      );
      const response = yield* Deferred.await(received).pipe(Effect.timeout("2 seconds"));
      expect(response).toBe("clipboard owner alive");
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
);

it.effect("bounds a stalled native clipboard helper and releases its scope", () =>
  Effect.gen(function* () {
    const test = adapter("darwin", ["pending"]);
    const fiber = yield* LogsClipboard.use((clipboard) => clipboard.copy(payload)).pipe(
      Effect.provide(test.layer),
      Effect.flip,
      Effect.forkScoped,
    );
    yield* Deferred.await(test.started);
    yield* TestClock.adjust("3 seconds");
    const error = yield* Fiber.join(fiber);
    expect(error.reason).toBe("timeout");
    expect(error.message).toBe("Copy timed out; check clipboard access.");
    yield* Deferred.await(test.stopped);
  }),
);
