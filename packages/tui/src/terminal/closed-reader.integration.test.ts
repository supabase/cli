import { NodeStream } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Fiber, Stream } from "effect";
// oxlint-disable-next-line effecttsgo/node-builtin-import -- the Effect spawner cannot close its read end of the pipe.
import { spawn, type ChildProcess } from "node:child_process";
import type { Readable } from "node:stream";
import { fileURLToPath } from "node:url";

const fixture = fileURLToPath(new URL("./fixtures/closed-reader.ts", import.meta.url));

const spawnFixture = Effect.acquireRelease(
  Effect.sync(() => spawn(process.execPath, [fixture], { stdio: ["ignore", "pipe", "pipe"] })),
  (child) =>
    Effect.sync(() => {
      child.kill();
    }),
);

const readable = (stream: Readable) =>
  NodeStream.fromReadable({
    evaluate: () => stream,
    onError: (cause) => new Error("fixture stdio failed", { cause }),
  });

const closed = (child: ChildProcess) =>
  Effect.callback<number | null>((resume) => {
    const onClose = (code: number | null) => resume(Effect.succeed(code));
    child.once("close", onClose);
    return Effect.sync(() => {
      child.off("close", onClose);
    });
  });

describe("Terminal.layerProcess with a reader that closes early", () => {
  it.live(
    "reports the failed write as a TerminalError instead of crashing on the stream's error event",
    () =>
      Effect.gen(function* () {
        const child = yield* spawnFixture;
        if (child.stdout === null || child.stderr === null) {
          return yield* Effect.die(new Error("the fixture's stdio is not piped"));
        }
        const exit = yield* Effect.forkScoped(closed(child), { startImmediately: true });
        const stderr = yield* Effect.forkScoped(
          Stream.mkString(Stream.decodeText(readable(child.stderr))),
          { startImmediately: true },
        );

        // Ending the read of stdout destroys the parent's end of the pipe, as a closing `| head` does.
        yield* Stream.runDrain(Stream.take(readable(child.stdout), 1));

        const output = yield* Fiber.join(stderr);
        expect(output).not.toContain("Unhandled 'error' event");
        expect(output).not.toContain("EPIPE");
        expect(output.split("\n")).toEqual(["terminal-error: write", ""]);
        expect(yield* Fiber.join(exit)).toBe(0);
      }).pipe(Effect.scoped),
    30_000,
  );
});
