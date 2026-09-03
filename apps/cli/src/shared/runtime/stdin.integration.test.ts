import { fileURLToPath } from "node:url";
import { describe, expect, it } from "@effect/vitest";
import { Duration, Effect, Fiber, Layer, Option, Queue, Ref, Stream } from "effect";
import { TestClock } from "effect/testing";

import { mockTty } from "../../../tests/helpers/mocks.ts";
import { Stdin } from "./stdin.service.ts";
import { stdinLayerFrom } from "./stdin.layer.ts";

const enc = (s: string) => new TextEncoder().encode(s);

// Exercises the real `stdinLayer` (its persistent, lazily-opened line reader) over a
// controllable byte stream, instead of the array-indexing `mockStdin` double, so stdin
// can be driven with deliberate chunking / delays; `Tty` is satisfied by `mockTty`.
const withStdin = (stdin: Stream.Stream<Uint8Array>, stdinIsTty = false) =>
  stdinLayerFrom(stdin).pipe(Layer.provide(mockTty({ stdinIsTty, stdoutIsTty: false })));

describe("stdinLayer readLine", () => {
  it.live("dispenses successive lines across calls, buffering multi-line chunks", () => {
    // Two chunks; the second carries two lines. A persistent reader must return a, b,
    // c across successive calls (the second call pulls a fresh chunk, the third is
    // served from the buffered remainder) — one bufio.Scanner, not a fresh read each
    // time. A final call on the exhausted stream yields None (the prompt default).
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
    // A pipe that stays open without a newline (Go's non-TTY `ReadLine` timeout,
    // console.go:36): readLine must give up with None so the prompt takes its default
    // instead of blocking on EOF.
    const layer = withStdin(Stream.never);
    return Effect.gen(function* () {
      const stdin = yield* Stdin;
      expect(yield* stdin.readLine(100)).toStrictEqual(Option.none());
    }).pipe(Effect.provide(layer));
  });

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
