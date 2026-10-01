import { describe, expect, it } from "@effect/vitest";
import type { LaunchOutput } from "../runtime/Session.ts";
import {
  encodeEntry,
  makeSplitter,
  endedLineGraceMillis,
  maxLineBytes,
  parseRecord,
  segmentGeneration,
  segmentName,
  type LogEntry,
  type Splitter,
} from "./LogRecord.ts";

const bytes = (text: string) => new TextEncoder().encode(text);
const chunk = (
  launchId: number,
  seq: number,
  text: string,
  stream: "stdout" | "stderr" = "stdout",
  part = 0,
): LaunchOutput => ({ stream, bytes: bytes(text), launchId, part, seq, time: 0 });
/** Pushes a chunk as if it had been published at `time`. */
const push = (splitter: Splitter, value: LaunchOutput, time: number) =>
  splitter.push({ ...value, time });
const lines = (entries: ReadonlyArray<LogEntry>) =>
  entries.flatMap((entry) =>
    entry.kind === "stdout" || entry.kind === "stderr" ? [entry.text] : [],
  );
const position = { generation: 3, byteOffset: 42 };

describe("record format", () => {
  it("round-trips every record kind with its launch id", () => {
    const entries: ReadonlyArray<LogEntry> = [
      { kind: "stdout", timestamp: 0, launchId: 2, text: "ready | with a pipe", truncated: false },
      { kind: "stderr", timestamp: 1_000, launchId: 2, text: "cut", truncated: true },
      { kind: "launch", timestamp: 2_000, launchId: 3 },
      { kind: "lost", timestamp: 3_000, launchId: 3, stream: "stderr", count: 7 },
    ];

    const encoded = entries.map(encodeEntry);
    const parsed = encoded.map((line) => parseRecord(line.slice(0, -1), position));

    expect(encoded[0]).toBe("1970-01-01T00:00:00.000Z stdout 2 | ready | with a pipe\n");
    expect(encoded[1]).toBe("1970-01-01T00:00:01.000Z stderr 2 truncated | cut\n");
    expect(parsed).toEqual([
      {
        kind: "stdout",
        timestamp: "1970-01-01T00:00:00.000Z",
        launchId: 2,
        text: "ready | with a pipe",
        position,
      },
      {
        kind: "stderr",
        timestamp: "1970-01-01T00:00:01.000Z",
        launchId: 2,
        text: "cut",
        truncated: true,
        position,
      },
      { kind: "launch", timestamp: "1970-01-01T00:00:02.000Z", launchId: 3, position },
      {
        kind: "lost",
        timestamp: "1970-01-01T00:00:03.000Z",
        launchId: 3,
        stream: "stderr",
        count: 7,
        position,
      },
    ]);
  });

  it("ignores lines that are not records", () => {
    expect(parseRecord("half a rec", position)).toBeUndefined();
    expect(parseRecord("2026-09-29T10:00:00.000Z info 1 | text", position)).toBeUndefined();
  });

  it("names segments so only generation files are listed", () => {
    expect(segmentName(12)).toBe("0000000012.log");
    expect(segmentGeneration(segmentName(12))).toBe(12);
    expect(segmentGeneration("cursor.json")).toBeUndefined();
    expect(segmentGeneration("0000000012.log.tmp")).toBeUndefined();
  });
});

describe("splitter", () => {
  it("joins lines across chunk boundaries, including split CRLF and multibyte text", () => {
    const splitter = makeSplitter();
    const euro = bytes("€");
    const first = push(splitter, chunk(1, 0, "alpha\r"), 10);
    const second = push(splitter, chunk(1, 1, "\nbe"), 20);
    const third = push(
      splitter,
      {
        stream: "stdout",
        bytes: new Uint8Array([...bytes("ta "), ...euro.subarray(0, 1)]),
        launchId: 1,
        part: 0,
        seq: 2,
        time: 0,
      },
      30,
    );
    const fourth = push(
      splitter,
      {
        stream: "stdout",
        bytes: new Uint8Array([...euro.subarray(1), 0x0a]),
        launchId: 1,
        part: 0,
        seq: 3,
        time: 0,
      },
      40,
    );

    expect(first[0]).toEqual({ kind: "launch", timestamp: 10, launchId: 1 });
    expect(lines(first)).toEqual(["alpha"]);
    expect(lines(second)).toEqual([]);
    expect(third).toEqual([]);
    expect(fourth).toEqual([
      { kind: "stdout", timestamp: 20, launchId: 1, text: "beta €", truncated: false },
    ]);
  });

  it("treats a lone carriage return and empty lines as line ends", () => {
    const splitter = makeSplitter();

    expect(lines(push(splitter, chunk(1, 0, "10%\r20%\r\n\nnext\n"), 0))).toEqual([
      "10%",
      "20%",
      "",
      "next",
    ]);
  });

  it("keeps a late chunk of an earlier launch in that launch after a later launch starts", () => {
    const splitter = makeSplitter();
    push(splitter, chunk(1, 0, "failed par"), 10);

    const relaunched = push(splitter, chunk(2, 0, "second\n"), 20);
    const late = push(splitter, chunk(1, 1, "late\n"), 30);

    expect(relaunched).toEqual([
      { kind: "stdout", timestamp: 10, launchId: 1, text: "failed par", truncated: false },
      { kind: "launch", timestamp: 20, launchId: 2 },
      { kind: "stdout", timestamp: 20, launchId: 2, text: "second", truncated: false },
    ]);
    expect(late).toEqual([
      { kind: "stdout", timestamp: 30, launchId: 1, text: "late", truncated: false },
    ]);
  });

  it("flushes a launch's partial line when it ends and keeps a late line whole across batches", () => {
    const splitter = makeSplitter();
    push(splitter, chunk(1, 0, "no newline"), 10);

    const ended = splitter.endLaunch(1, 20);
    const early = [...push(splitter, chunk(1, 1, "late "), 30), ...splitter.flushEnded(31)];
    const completed = [...push(splitter, chunk(1, 2, "tail\n"), 40), ...splitter.flushEnded(41)];

    expect(ended).toEqual([
      { kind: "stdout", timestamp: 10, launchId: 1, text: "no newline", truncated: false },
    ]);
    expect(early).toEqual([]);
    expect(completed).toEqual([
      { kind: "stdout", timestamp: 30, launchId: 1, text: "late tail", truncated: false },
    ]);
  });

  it("flushes a late partial of an ended launch once it stays idle for the grace", () => {
    const splitter = makeSplitter();
    splitter.endLaunch(1, 0);
    push(splitter, chunk(1, 0, "idle partial"), 50);

    const waiting = splitter.flushEnded(50 + endedLineGraceMillis - 1);
    const flushed = splitter.flushEnded(50 + endedLineGraceMillis);

    expect(waiting).toEqual([]);
    expect(lines(flushed)).toEqual(["idle partial"]);
  });
  it("reports a whole process of a launch whose chunks were dropped", () => {
    const splitter = makeSplitter();
    push(splitter, chunk(1, 0, "startup\n", "stdout", 0), 10);

    const main = push(splitter, chunk(1, 3, "main\n", "stdout", 2), 20);

    expect(main).toEqual([
      { kind: "lost", timestamp: 20, launchId: 1, stream: "stdout", count: 2 },
      { kind: "stdout", timestamp: 20, launchId: 1, text: "main", truncated: false },
    ]);
  });

  it("stamps a line with the publish time of its first byte when a character spans chunks", () => {
    const splitter = makeSplitter();
    const euro = bytes("€");

    const first = push(splitter, { ...chunk(1, 0, ""), bytes: euro.subarray(0, 1) }, 10);
    const second = push(
      splitter,
      { ...chunk(1, 1, ""), bytes: new Uint8Array([...euro.subarray(1), 0x0a]) },
      20,
    );

    expect(first).toEqual([{ kind: "launch", timestamp: 10, launchId: 1 }]);
    expect(second).toEqual([
      { kind: "stdout", timestamp: 10, launchId: 1, text: "€", truncated: false },
    ]);
  });

  it.each(["€", "😀"])(
    "stamps a line with its first byte's time when %s spans one chunk per byte",
    (character) => {
      const splitter = makeSplitter();
      const encoded = bytes(`${character}\n`);

      const pushed = Array.from(encoded, (byte, seq) =>
        push(splitter, { ...chunk(1, seq, ""), bytes: new Uint8Array([byte]) }, 10 * (seq + 1)),
      );

      expect(pushed.at(-1)).toEqual([
        { kind: "stdout", timestamp: 10, launchId: 1, text: character, truncated: false },
      ]);
    },
  );

  it("ends a startup command's unterminated line when the main process of the launch starts", () => {
    const splitter = makeSplitter();
    push(splitter, chunk(1, 0, "migrations applied", "stdout", 0), 10);

    const main = push(splitter, chunk(1, 1, "listening\n", "stdout", 1), 20);

    expect(main).toEqual([
      { kind: "stdout", timestamp: 10, launchId: 1, text: "migrations applied", truncated: false },
      { kind: "stdout", timestamp: 20, launchId: 1, text: "listening", truncated: false },
    ]);
  });

  it("reports a sequence gap as lost chunks and drops the interrupted partial line", () => {
    const splitter = makeSplitter();
    push(splitter, chunk(1, 0, "interrupted"), 10);

    const resumed = push(splitter, chunk(1, 4, "resumed\n", "stdout"), 20);

    expect(resumed).toEqual([
      { kind: "lost", timestamp: 20, launchId: 1, stream: "stdout", count: 3 },
      { kind: "stdout", timestamp: 20, launchId: 1, text: "resumed", truncated: false },
    ]);
  });

  it("marks the first chunk of an earlier launch that arrives after a later launch", () => {
    const splitter = makeSplitter();
    push(splitter, chunk(2, 0, "second\n"), 10);

    const late = push(splitter, chunk(1, 0, "failed early\n"), 20);

    expect(late).toEqual([
      { kind: "launch", timestamp: 20, launchId: 1 },
      { kind: "stdout", timestamp: 20, launchId: 1, text: "failed early", truncated: false },
    ]);
  });

  it("reports chunks lost before the first one it sees", () => {
    const splitter = makeSplitter();

    expect(push(splitter, chunk(5, 2, "x\n", "stderr"), 0).slice(0, 2)).toEqual([
      { kind: "launch", timestamp: 0, launchId: 5 },
      { kind: "lost", timestamp: 0, launchId: 5, stream: "stderr", count: 2 },
    ]);
  });

  it("truncates an over-long line at a character boundary and drops the rest of it", () => {
    const splitter = makeSplitter(8);

    const first = push(splitter, chunk(1, 0, "abcdefg€"), 10);
    const rest = push(splitter, chunk(1, 1, "more\nnext\n", "stdout"), 20);

    expect(first.slice(1)).toEqual([
      { kind: "stdout", timestamp: 10, launchId: 1, text: "abcdefg", truncated: true },
    ]);
    expect(rest).toEqual([
      { kind: "stdout", timestamp: 20, launchId: 1, text: "next", truncated: false },
    ]);
  });

  it("caps lines at 32 KiB by default", () => {
    const splitter = makeSplitter();

    const [, cut] = push(splitter, chunk(1, 0, `${"x".repeat(maxLineBytes + 10)}\n`), 0);

    expect(cut).toMatchObject({ kind: "stdout", truncated: true });
    expect(cut?.kind === "stdout" ? cut.text.length : 0).toBe(maxLineBytes);
  });

  it("keeps stdout and stderr lines apart", () => {
    const splitter = makeSplitter();
    push(splitter, chunk(1, 0, "out "), 0);
    push(splitter, chunk(1, 0, "err\n", "stderr"), 0);

    expect(splitter.flush(1)).toEqual([
      { kind: "stdout", timestamp: 0, launchId: 1, text: "out ", truncated: false },
    ]);
  });
});
