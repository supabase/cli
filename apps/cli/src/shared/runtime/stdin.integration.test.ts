import { fileURLToPath } from "node:url";
import { describe, expect, it } from "@effect/vitest";
import { Duration, Effect, Fiber, Layer, Option, Queue, Ref, Stream } from "effect";
import { systemError, type PlatformError } from "effect/PlatformError";
import { TestClock } from "effect/testing";

import { mockTty } from "../../../tests/helpers/mocks.ts";
import { Stdin } from "./stdin.service.ts";
import { stdinLayerFrom } from "./stdin.layer.ts";

const enc = (s: string) => new TextEncoder().encode(s);

// Exercises the real `stdinLayer` (its persistent, lazily-opened line reader) over a
// controllable byte stream, instead of the array-indexing `mockStdin` double, so stdin
// can be driven with deliberate chunking / delays; `Tty` is satisfied by `mockTty`.
const withStdin = (stdin: Stream.Stream<Uint8Array, PlatformError>, stdinIsTty = false) =>
  stdinLayerFrom(stdin).pipe(Layer.provide(mockTty({ stdinIsTty, stdoutIsTty: false })));

describe("stdinLayer", () => {
  it.live("dispenses successive lines across calls, buffering multi-line chunks", () => {
    // Two chunks, the second carrying two lines: one persistent reader returns a, b, c
    // across successive calls, holding the rest of a chunk for the next call instead of
    // starting over. A final call on the exhausted stream yields None (the prompt default).
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
    // splitLines keeps blank interior lines: a caller that pipes "\ny\n" sees the
    // blank line first (→ prompt default) and the y second, not y first.
    const layer = withStdin(Stream.fromIterable([enc("\ny\n")]));
    return Effect.gen(function* () {
      const stdin = yield* Stdin;
      expect(yield* stdin.readLine(10_000)).toStrictEqual(Option.some(""));
      expect(yield* stdin.readLine(10_000)).toStrictEqual(Option.some("y"));
    }).pipe(Effect.provide(layer));
  });

  it.live("times out to None when no line arrives within the window", () => {
    // A pipe that stays open without sending a line: readLine must give up with None so
    // the prompt takes its default instead of waiting for EOF.
    const layer = withStdin(Stream.never);
    return Effect.gen(function* () {
      const stdin = yield* Stdin;
      expect(yield* stdin.readLine(100)).toStrictEqual(Option.none());
    }).pipe(Effect.provide(layer));
  });

  it.live("waits for a non-blocking pipe that has nothing to read yet", () =>
    Effect.gen(function* () {
      // A non-blocking fd 0 with nothing to read yet fails the read with `WouldBlock` (how the
      // layer reports `EAGAIN`, pinned over a real fd 0 below). That is "nothing yet", not EOF:
      // the reader keeps asking until the answer lands, instead of taking the default for this
      // prompt and every one after it.
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
      // The first prompt times out between two looks, interrupting the wait. The next prompt
      // must take the wait back up and see the answer once it lands, instead of inheriting the
      // failed read as the reader's last word.
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
      // The whole-pipe collects wait a non-blocking fd 0 out the same way, and a fresh reader
      // over the still-open descriptor carries on where the last one stopped, so what came
      // before the empty read and what comes after it read as one stream.
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
      // A slow producer: the first prompt times out holding a partial line, and the bytes
      // that complete it must still reach the next prompt.
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
      // Two prompts wait at once. The second must get `2`, held back from the chunk the first
      // one pulled, instead of pulling a chunk of its own and skipping it. Each pull yields
      // once, so a second pull could slip in while the first is in flight.
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
      // An endless producer, counted per chunk: nothing is pulled before the first prompt
      // or between prompts, so whatever the prompts do not ask for stays in the pipe.
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
    // The 10,000th prompt still gets the 10,000th line, and an unbounded producer is only
    // read as far as the prompts ask. The lines total well over 64 KiB, so the pending-line
    // bound must reset at each line break.
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
      // A producer that never sends a newline (`yes | tr -d '\n'`), counted per 16 KiB
      // chunk: the reader stops pulling once the pending line outgrows its 64 KiB bound
      // (the fifth chunk), and every prompt from then on takes its default.
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
    // `{ printf 'y\n'; cat blob-without-newline; } | …` can land the answer and the start
    // of the blob in one pull. The answer is still delivered; the tail then trips the bound,
    // so the `n` behind it is never read and every later prompt takes its default.
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
    // A parent that hands fd 0 down in non-blocking mode: perl flips `O_NONBLOCK` on the pipe
    // (Bun cannot), confirms the mode on stderr and execs the reader. The first prompt finds
    // the pipe empty and must run out its window to None instead of taking the empty read as a
    // dead descriptor; the second must read the answer written once that window has closed.
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
    // The production adapter in a real process: 2 MiB of lines are piped in, three prompts
    // take the first three, then a child inheriting fd 0 counts what is left in the pipe.
    // A reader that drained stdin would leave it nothing; this one reads a chunk ahead.
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
