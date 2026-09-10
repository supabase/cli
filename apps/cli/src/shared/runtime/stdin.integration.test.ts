import { fileURLToPath } from "node:url";
import { describe, expect, it } from "@effect/vitest";
import { Duration, Effect, Fiber, Layer, Option, Queue, Ref, Stream } from "effect";
import { systemError, type PlatformError } from "effect/PlatformError";
import { TestClock } from "effect/testing";

import { mockTty } from "../../../tests/helpers/mocks.ts";
import { Stdin } from "./stdin.service.ts";
import { stdinLayerFrom } from "./stdin.layer.ts";

const enc = (s: string) => new TextEncoder().encode(s);

// Exercises the real `stdinLayer` over a controllable byte stream (not the
// array-indexing `mockStdin` double) so stdin can be driven with deliberate chunking/delays.
const withStdin = (stdin: Stream.Stream<Uint8Array, PlatformError>, stdinIsTty = false) =>
  stdinLayerFrom(stdin).pipe(Layer.provide(mockTty({ stdinIsTty, stdoutIsTty: false })));

describe("stdinLayer", () => {
  it.live("dispenses successive lines across calls, buffering multi-line chunks", () => {
    // Two chunks; the second carries two lines to prove buffering across calls.
    const layer = withStdin(Stream.fromIterable([enc("a\n"), enc("b\nc\n")]));
    return Effect.gen(function* () {
      const stdin = yield* Stdin;
      expect(yield* stdin.readLine(10_000)).toStrictEqual(Option.some("a"));
      expect(yield* stdin.readLine(10_000)).toStrictEqual(Option.some("b"));
      expect(yield* stdin.readLine(10_000)).toStrictEqual(Option.some("c"));
      expect(yield* stdin.readLine(10_000)).toStrictEqual(Option.none());
    }).pipe(Effect.provide(layer));
  });

  it.live("accepts CRLF and bare CR line endings and a final line without one", () => {
    // Answers piped from Windows tooling (`\r\n`) or an old Mac convention (`\r`), plus
    // `printf y` with no trailing newline, all read as whole lines before EOF.
    const layer = withStdin(Stream.fromIterable([enc("a\r\nb\rc")]));
    return Effect.gen(function* () {
      const stdin = yield* Stdin;
      expect(yield* stdin.readLine(10_000)).toStrictEqual(Option.some("a"));
      expect(yield* stdin.readLine(10_000)).toStrictEqual(Option.some("b"));
      expect(yield* stdin.readLine(10_000)).toStrictEqual(Option.some("c"));
      expect(yield* stdin.readLine(10_000)).toStrictEqual(Option.none());
    }).pipe(Effect.provide(layer));
  });

  it.live("preserves interior blank lines so answers stay aligned", () => {
    // A caller piping "\ny\n" must see the blank line first, then "y" — not "y" first.
    const layer = withStdin(Stream.fromIterable([enc("\ny\n")]));
    return Effect.gen(function* () {
      const stdin = yield* Stdin;
      expect(yield* stdin.readLine(10_000)).toStrictEqual(Option.some(""));
      expect(yield* stdin.readLine(10_000)).toStrictEqual(Option.some("y"));
    }).pipe(Effect.provide(layer));
  });

  it.live("times out to None when no line arrives within the window", () => {
    const layer = withStdin(Stream.never);
    return Effect.gen(function* () {
      const stdin = yield* Stdin;
      expect(yield* stdin.readLine(100)).toStrictEqual(Option.none());
    }).pipe(Effect.provide(layer));
  });

  it.live("waits for a non-blocking pipe that has nothing to read yet", () =>
    Effect.gen(function* () {
      // A non-blocking fd 0 with nothing to read fails with `WouldBlock` (how
      // the layer reports `EAGAIN`) — "nothing yet", not EOF.
      let attempts = 0;
      const layer = withStdin(
        Stream.suspend(() => {
          attempts += 1;
          return attempts < 3
            ? Stream.fail(systemError({ module: "Stdin", method: "read", _tag: "WouldBlock" }))
            : Stream.make(enc("y\n"));
        }),
      );
      yield* Effect.gen(function* () {
        const stdin = yield* Stdin;
        expect(yield* stdin.readLine(10_000)).toStrictEqual(Option.some("y"));
        expect(attempts).toBe(3);
      }).pipe(Effect.provide(layer));
    }),
  );

  it.effect("keeps waiting on a non-blocking pipe across a prompt that gave up", () =>
    Effect.gen(function* () {
      // A timed-out prompt must not leave the reader stuck on the failed read;
      // the next prompt resumes waiting and sees the answer once it lands.
      const ready = yield* Ref.make(false);
      const layer = withStdin(
        Stream.unwrap(
          Ref.get(ready).pipe(
            Effect.map((isReady) =>
              isReady
                ? Stream.make(enc("y\n"))
                : Stream.fail(systemError({ module: "Stdin", method: "read", _tag: "WouldBlock" })),
            ),
          ),
        ),
      );
      yield* Effect.gen(function* () {
        const stdin = yield* Stdin;
        const gaveUp = yield* Effect.forkChild(stdin.readLine(100));
        yield* TestClock.adjust(Duration.millis(100));
        expect(yield* Fiber.join(gaveUp)).toStrictEqual(Option.none());
        yield* Ref.set(ready, true);
        const answered = yield* Effect.forkChild(stdin.readLine(10_000));
        yield* TestClock.adjust(Duration.millis(10));
        expect(yield* Fiber.join(answered)).toStrictEqual(Option.some("y"));
      }).pipe(Effect.provide(layer));
    }),
  );

  it.effect("collects a pipe across a non-blocking read that had nothing yet", () =>
    Effect.gen(function* () {
      // `readPipedText` waits out a non-blocking fd 0 the same way readLine does,
      // and a fresh reader continues where the last one stopped.
      let attempts = 0;
      const layer = withStdin(
        Stream.suspend(() => {
          attempts += 1;
          return attempts === 1
            ? Stream.concat(
                Stream.make(enc("ab")),
                Stream.fail(systemError({ module: "Stdin", method: "read", _tag: "WouldBlock" })),
              )
            : Stream.make(enc("cd"));
        }),
      );
      yield* Effect.gen(function* () {
        const stdin = yield* Stdin;
        const collected = yield* Effect.forkChild(stdin.readPipedText);
        yield* TestClock.adjust(Duration.millis(10));
        expect(yield* Fiber.join(collected)).toStrictEqual(Option.some("abcd"));
        expect(attempts).toBe(2);
      }).pipe(Effect.provide(layer));
    }),
  );

  it.effect("keeps reading after a prompt times out, finishing the line it was waiting on", () =>
    Effect.gen(function* () {
      // A slow producer: the first prompt times out mid-line; the bytes that
      // complete it must still reach the next prompt.
      const queue = yield* Queue.unbounded<Uint8Array>();
      const layer = withStdin(Stream.fromQueue(queue));
      yield* Effect.gen(function* () {
        const stdin = yield* Stdin;
        yield* Queue.offer(queue, enc("ab"));
        const reading = yield* Effect.forkChild(stdin.readLine(100));
        yield* TestClock.adjust(Duration.millis(100));
        expect(yield* Fiber.join(reading)).toStrictEqual(Option.none());
        yield* Queue.offer(queue, enc("c\nd\n"));
        expect(yield* stdin.readLine(10_000)).toStrictEqual(Option.some("abc"));
        expect(yield* stdin.readLine(10_000)).toStrictEqual(Option.some("d"));
      }).pipe(Effect.provide(layer));
    }),
  );

  it.live("lets one prompt at a time pull from the pipe", () =>
    Effect.gen(function* () {
      // Two prompts wait at once; the second must get the value held back from
      // the first prompt's chunk, not pull (and skip) a chunk of its own.
      let pulls = 0;
      const layer = withStdin(
        Stream.fromEffectRepeat(
          Effect.suspend(() => {
            pulls += 1;
            return Effect.yieldNow.pipe(Effect.as(enc(`${2 * pulls - 1}\n${2 * pulls}\n`)));
          }),
        ),
      );
      yield* Effect.gen(function* () {
        const stdin = yield* Stdin;
        const answers = yield* Effect.all([stdin.readLine(10_000), stdin.readLine(10_000)], {
          concurrency: "unbounded",
        });
        expect(answers.map(Option.getOrThrow).sort()).toStrictEqual(["1", "2"]);
        expect(yield* stdin.readLine(10_000)).toStrictEqual(Option.some("3"));
      }).pipe(Effect.provide(layer));
    }),
  );

  it.live("reads a pipe only while a prompt is waiting", () =>
    Effect.gen(function* () {
      // Nothing is pulled before the first prompt or between prompts; the
      // producer is counted per chunk to prove that.
      const pulled = yield* Ref.make(0);
      const layer = withStdin(
        Stream.fromEffectRepeat(
          Ref.updateAndGet(pulled, (n) => n + 1).pipe(Effect.map((n) => enc(`line-${n}\n`))),
        ),
      );
      yield* Effect.gen(function* () {
        const stdin = yield* Stdin;
        expect(yield* Ref.get(pulled)).toBe(0);
        expect(yield* stdin.readLine(10_000)).toStrictEqual(Option.some("line-1"));
        expect(yield* Ref.get(pulled)).toBe(1);
        expect(yield* stdin.readLine(10_000)).toStrictEqual(Option.some("line-2"));
        expect(yield* Ref.get(pulled)).toBe(2);
      }).pipe(Effect.provide(layer));
    }),
  );

  it.live("answers every prompt in order when a producer floods the pipe", () => {
    // 10,000 lines total well over the 64 KiB pending-line bound, so that
    // bound must reset at each line break, not accumulate across lines.
    const flood = Array.from({ length: 10_000 }, (_, index) => enc(`line-${index}\n`));
    const layer = withStdin(Stream.fromIterable(flood).pipe(Stream.concat(Stream.never)));
    return Effect.gen(function* () {
      const stdin = yield* Stdin;
      for (let index = 0; index < 10_000; index++) {
        expect(yield* stdin.readLine(10_000)).toStrictEqual(Option.some(`line-${index}`));
      }
    }).pipe(Effect.provide(layer));
  });

  it.live("gives up on a line that never ends instead of buffering it", () =>
    Effect.gen(function* () {
      // A newline-less producer (`yes | tr -d '\n'`), counted per 16 KiB chunk:
      // the reader stops pulling once the pending line exceeds its 64 KiB
      // bound (at the fifth chunk).
      const pulled = yield* Ref.make(0);
      const chunk = enc("y".repeat(16 * 1024));
      const layer = withStdin(
        Stream.fromEffectRepeat(Ref.update(pulled, (n) => n + 1).pipe(Effect.as(chunk))),
      );
      yield* Effect.gen(function* () {
        const stdin = yield* Stdin;
        expect(yield* stdin.readLine(10_000)).toStrictEqual(Option.none());
        expect(yield* Ref.get(pulled)).toBe(5);
        expect(yield* stdin.readLine(10_000)).toStrictEqual(Option.none());
        expect(yield* Ref.get(pulled)).toBe(5);
      }).pipe(Effect.provide(layer));
    }),
  );

  it.live("answers the lines ahead of a runaway tail that shares their chunk", () => {
    // The answer and the start of an unterminated blob can land in one pull;
    // the answer still delivers, then the blob trips the bound so the "n"
    // behind it is never read.
    const layer = withStdin(
      Stream.fromArray([enc("y\n"), enc("z".repeat(64 * 1024 + 1))]).pipe(
        Stream.concat(Stream.make(enc("n\n"))),
      ),
    );
    return Effect.gen(function* () {
      const stdin = yield* Stdin;
      expect(yield* stdin.readLine(10_000)).toStrictEqual(Option.some("y"));
      expect(yield* stdin.readLine(10_000)).toStrictEqual(Option.none());
    }).pipe(Effect.provide(layer));
  });

  it.live("dispenses successive lines on a TTY, which is read only when prompted", () => {
    const layer = withStdin(Stream.fromIterable([enc("a\n"), enc("b\nc\n")]), true);
    return Effect.gen(function* () {
      const stdin = yield* Stdin;
      expect(yield* stdin.readLine(10_000)).toStrictEqual(Option.some("a"));
      expect(yield* stdin.readLine(10_000)).toStrictEqual(Option.some("b"));
      expect(yield* stdin.readLine(10_000)).toStrictEqual(Option.some("c"));
      expect(yield* stdin.readLine(10_000)).toStrictEqual(Option.none());
    }).pipe(Effect.provide(layer));
  });

  it.effect("times out to None on a TTY when the user does not answer in time", () => {
    const layer = withStdin(Stream.never, true);
    return Effect.gen(function* () {
      const stdin = yield* Stdin;
      const reading = yield* Effect.forkChild(stdin.readLine(100));
      yield* TestClock.adjust(Duration.millis(100));
      expect(yield* Fiber.join(reading)).toStrictEqual(Option.none());
    }).pipe(Effect.provide(layer));
  });
});

describe("stdinLayer over fd 0", () => {
  it("waits out a non-blocking fd 0 until the answer lands", async () => {
    // perl flips `O_NONBLOCK` on stdin (Bun cannot) and execs into the reader
    // so fd 0 stays non-blocking. The first prompt must run its window out to
    // None rather than treat the empty read as a dead descriptor; the second
    // reads the answer once that window closes.
    const bun = Bun.which("bun");
    const perl = Bun.which("perl");
    if (!bun || !perl) throw new Error("bun and perl executables not found");
    const here = (file: string) => JSON.stringify(fileURLToPath(new URL(file, import.meta.url)));
    const child = Bun.spawn(
      [
        perl,
        "-e",
        `use Fcntl;
         fcntl(STDIN, F_SETFL, O_NONBLOCK) or die "fcntl: $!";
         print STDERR ((fcntl(STDIN, F_GETFL, 0) & O_NONBLOCK) ? "nonblock\\n" : "block\\n");
         exec @ARGV or die "exec: $!";`,
        bun,
        "-e",
        `import { Effect, Layer, Option } from "effect";
         import { Stdin } from ${here("./stdin.service.ts")};
         import { stdinLayer } from ${here("./stdin.layer.ts")};
         import { ttyLayer } from ${here("./tty.layer.ts")};
         const program = Effect.gen(function* () {
           const stdin = yield* Stdin;
           console.log(Option.getOrElse(yield* stdin.readLine(300), () => "<none>"));
           console.log(Option.getOrElse(yield* stdin.readLine(5_000), () => "<none>"));
         });
         Effect.runPromise(program.pipe(Effect.provide(stdinLayer.pipe(Layer.provide(ttyLayer))))).then(
           () => process.exit(0),
         );`,
      ],
      { cwd: import.meta.dirname, stdin: "pipe", stdout: "pipe", stderr: "pipe", timeout: 20_000 },
    );
    const stdout = child.stdout.pipeThrough(new TextDecoderStream()).getReader();
    let buffered = "";
    const nextLine = async () => {
      while (!buffered.includes("\n")) {
        const { value, done } = await stdout.read();
        if (done) throw new Error(`child exited early: ${await new Response(child.stderr).text()}`);
        buffered += value;
      }
      const [line, ...rest] = buffered.split("\n");
      buffered = rest.join("\n");
      return line;
    };
    try {
      expect(await nextLine()).toBe("<none>");
      await child.stdin.write("y\n");
      await child.stdin.flush();
      expect(await nextLine()).toBe("y");
      await child.stdin.end();
      const [exitCode, stderr] = await Promise.all([
        child.exited,
        new Response(child.stderr).text(),
      ]);
      expect(exitCode, stderr).toBe(0);
      expect(stderr).toContain("nonblock");
    } finally {
      // A failed assertion must not leave the child waiting on its second prompt.
      child.kill();
    }
  }, 30_000);

  it("answers prompts from a flooded pipe and leaves the rest for a child inheriting fd 0", async () => {
    // 2 MiB of lines piped in; three prompts take the first three, then a
    // child inheriting fd 0 counts what's left. A reader that fully drained
    // stdin would leave it nothing.
    const bun = Bun.which("bun");
    if (!bun) throw new Error("Bun executable not found");
    const here = (file: string) => JSON.stringify(fileURLToPath(new URL(file, import.meta.url)));
    const payload = enc(Array.from({ length: 200_000 }, (_, index) => `line-${index}\n`).join(""));
    const child = Bun.spawn(
      [
        bun,
        "-e",
        `import { Effect, Layer, Option } from "effect";
         import { Stdin } from ${here("./stdin.service.ts")};
         import { stdinLayer } from ${here("./stdin.layer.ts")};
         import { ttyLayer } from ${here("./tty.layer.ts")};
         const program = Effect.gen(function* () {
           const stdin = yield* Stdin;
           const answers = [];
           for (let index = 0; index < 3; index++) {
             answers.push(Option.getOrElse(yield* stdin.readLine(5_000), () => "<none>"));
           }
           console.log(answers.join(" "));
           const rest = Bun.spawn(
             [process.execPath, "-e", "let n = 0; for await (const c of Bun.stdin.stream()) n += c.length; console.log(n);"],
             { stdin: "inherit", stdout: "pipe" },
           );
           console.log(yield* Effect.promise(() => new Response(rest.stdout).text()));
         });
         Effect.runPromise(program.pipe(Effect.provide(stdinLayer.pipe(Layer.provide(ttyLayer))))).then(
           () => process.exit(0),
         );`,
      ],
      // Prompts give up after 3 x 5 s; a child that hangs anyway is killed at 20 s, ahead of
      // vitest's 30 s guard, so the failure still carries its stderr.
      { cwd: import.meta.dirname, stdin: payload, stdout: "pipe", stderr: "pipe", timeout: 20_000 },
    );
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect(exitCode, stderr).toBe(0);
    const [answers, left] = stdout.trim().split("\n");
    expect(answers).toBe("line-0 line-1 line-2");
    expect(payload.length - Number(left)).toBeLessThanOrEqual(256 * 1024);
  }, 30_000);
});
