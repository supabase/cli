import { DateTime, Schema } from "effect";
import type { LaunchOutput } from "../runtime/Session.ts";

const OutputStream = Schema.Literals(["stdout", "stderr"]);
type OutputStream = Schema.Schema.Type<typeof OutputStream>;

/** A byte position in an instance's log segments. */
export const LogPosition = Schema.Struct({
  generation: Schema.Int,
  byteOffset: Schema.Int,
});
export interface LogPosition extends Schema.Schema.Type<typeof LogPosition> {}

/**
 * One output line, launch, or `lost` marker; a gap over deleted segments has `resumeAt` instead
 * of `position`.
 */
export const LogRecord = Schema.Struct({
  kind: Schema.Literals(["stdout", "stderr", "launch", "lost"]),
  timestamp: Schema.String,
  launchId: Schema.optionalKey(Schema.Int),
  text: Schema.optionalKey(Schema.String),
  truncated: Schema.optionalKey(Schema.Boolean),
  stream: Schema.optionalKey(OutputStream),
  count: Schema.optionalKey(Schema.Int),
  position: Schema.optionalKey(LogPosition),
  resumeAt: Schema.optionalKey(LogPosition),
});
export interface LogRecord extends Schema.Schema.Type<typeof LogRecord> {}

/** A log record of one service instance in a stack. */
export const StackLogRecord = LogRecord.pipe(
  Schema.fieldsAssign({ service: Schema.String, instanceId: Schema.String }),
);
export interface StackLogRecord extends Schema.Schema.Type<typeof StackLogRecord> {}

/** A record before it is written; `timestamp` is epoch milliseconds. */
export type LogEntry =
  | {
      readonly kind: OutputStream;
      readonly timestamp: number;
      readonly launchId: number;
      readonly text: string;
      readonly truncated: boolean;
    }
  | { readonly kind: "launch"; readonly timestamp: number; readonly launchId: number }
  | {
      readonly kind: "lost";
      readonly timestamp: number;
      readonly launchId: number;
      readonly stream: OutputStream;
      readonly count: number;
    };

/** Lines are cut at this many UTF-8 bytes. */
const maxLineBytes = 32 * 1024;

const encoder = new TextEncoder();

/** Encodes one record as `<ISO time> <kind> <launch id>[ truncated] | <text>\n`. */
export const encodeEntry = (entry: LogEntry): string => {
  const time = DateTime.formatIso(DateTime.makeUnsafe(entry.timestamp));
  switch (entry.kind) {
    case "launch":
      return `${time} launch ${entry.launchId} | \n`;
    case "lost":
      return `${time} lost ${entry.launchId} | ${entry.count} ${entry.stream}\n`;
    default:
      return `${time} ${entry.kind} ${entry.launchId}${entry.truncated ? " truncated" : ""} | ${entry.text}\n`;
  }
};

const recordLine = /^(\S+) (stdout|stderr|launch|lost) (\d+)( truncated)? \| (.*)$/su;
const lostText = /^(\d+) (stdout|stderr)$/u;

/** Parses one record line without its trailing newline; unrecognized lines yield `undefined`. */
export const parseRecord = (line: string, position: LogPosition): LogRecord | undefined => {
  const match = recordLine.exec(line);
  if (match === null) return undefined;
  const [, timestamp = "", kind, launch = "", truncated, text = ""] = match;
  const launchId = Number(launch);
  if (kind === "stdout" || kind === "stderr")
    return {
      kind,
      timestamp,
      launchId,
      text,
      ...(truncated === undefined ? {} : { truncated: true }),
      position,
    };
  if (kind === "launch") return { kind, timestamp, launchId, position };
  const lost = lostText.exec(text);
  const stream = lost?.[2];
  return {
    kind: "lost",
    timestamp,
    launchId,
    ...(lost === null || (stream !== "stdout" && stream !== "stderr")
      ? {}
      : { count: Number(lost[1]), stream }),
    position,
  };
};

/** The file name of a segment generation. */
export const segmentName = (generation: number) => `${String(generation).padStart(10, "0")}.log`;

/** The generation a segment file name encodes, or `undefined` for other files. */
export const segmentGeneration = (name: string): number | undefined => {
  const match = /^(\d+)\.log$/u.exec(name);
  return match === null ? undefined : Number(match[1]);
};

interface LineState {
  readonly launchId: number;
  readonly part: number;
  readonly stream: OutputStream;
  decoder: TextDecoder;
  text: string;
  bytes: number;
  since: number | undefined;
  /** Bytes the decoder holds until their character completes. */
  held: Uint8Array;
  /** Publish time of the first held byte. */
  heldSince: number | undefined;
  /** Publish time of the latest chunk. */
  lastChunk: number;
  midCarriageReturn: boolean;
  discarding: boolean;
}

/** Converts tagged output chunks into records, keeping line state per launch, part and stream. */
export interface Splitter {
  /** Records take the publish time of their first byte. */
  readonly push: (chunk: LaunchOutput) => ReadonlyArray<LogEntry>;
  /** Marks a launch ended; `flushEnded` flushes its partial lines. */
  readonly endLaunch: (launchId: number) => void;
  /**
   * Flushes partial lines of ended launches: those of launches still ending once `idle` proves
   * every published chunk split, and late ones once they are idle for a grace.
   */
  readonly flushEnded: (now: number, idle: boolean) => ReadonlyArray<LogEntry>;
  /** The earliest time `flushEnded` has a partial line to flush, already past while a launch ends. */
  readonly endedDue: () => number | undefined;
  readonly flush: (now: number) => ReadonlyArray<LogEntry>;
}

/** Launches older than this many launches behind the newest lose their line state. */
const retainedLaunches = 4;
/** A launch first seen this far behind the newest may get a second `launch` record. */
const seenLaunches = 64;
/** A late partial line of an ended launch waits this long for its newline. */
export const endedLineGraceMillis = 2_000;

const noBytes = new Uint8Array(0);

/** The length of the UTF-8 sequence that `bytes` ends inside and a later chunk completes. */
const incompleteLength = (bytes: Uint8Array) => {
  for (let index = bytes.length - 1; index >= Math.max(0, bytes.length - 4); index--) {
    const byte = bytes[index] ?? 0;
    if ((byte & 0xc0) === 0x80) continue;
    const width = byte >= 0xf0 ? 4 : byte >= 0xe0 ? 3 : byte >= 0xc0 ? 2 : 1;
    return bytes.length - index < width ? bytes.length - index : 0;
  }
  return 0;
};

/** The last four bytes of the held bytes followed by `bytes`. */
const lastBytes = (held: Uint8Array, bytes: Uint8Array) => {
  if (bytes.length >= 4) return bytes.subarray(bytes.length - 4);
  const joined = new Uint8Array(held.length + bytes.length);
  joined.set(held);
  joined.set(bytes, held.length);
  return joined.subarray(Math.max(0, joined.length - 4));
};

/** Splits lines like `Stream.decodeText` plus `Stream.splitLines`, per launch, part and stream. */
export const makeSplitter = (limit = maxLineBytes): Splitter => {
  const states = new Map<string, LineState>();
  const ended = new Set<number>();
  /** Ended launches whose partial lines wait only for the output published before the end. */
  const ending = new Set<number>();
  const latestParts = new Map<number, number>();
  /** Next expected `seq` per launch and stream, which spans the launch's parts. */
  const expected = new Map<string, number>();
  const seen = new Set<number>();
  let latest = 0;

  const resetLine = (state: LineState) => {
    state.text = "";
    state.bytes = 0;
    state.since = undefined;
    state.discarding = false;
  };
  const append = (state: LineState, piece: string, time: number, out: Array<LogEntry>) => {
    if (piece.length === 0 || state.discarding) return;
    state.since ??= time;
    const size = encoder.encode(piece).length;
    if (state.bytes + size <= limit) {
      state.text += piece;
      state.bytes += size;
      return;
    }
    const kept = piece.slice(
      0,
      encoder.encodeInto(piece, new Uint8Array(limit - state.bytes)).read,
    );
    out.push({
      kind: state.stream,
      timestamp: state.since,
      launchId: state.launchId,
      text: state.text + kept,
      truncated: true,
    });
    resetLine(state);
    state.discarding = true;
  };
  const terminate = (state: LineState, now: number, out: Array<LogEntry>) => {
    if (!state.discarding)
      out.push({
        kind: state.stream,
        timestamp: state.since ?? now,
        launchId: state.launchId,
        text: state.text,
        truncated: false,
      });
    resetLine(state);
  };
  const flushLine = (state: LineState, now: number, out: Array<LogEntry>) => {
    append(state, state.decoder.decode(), state.heldSince ?? now, out);
    state.decoder = new TextDecoder();
    state.held = noBytes;
    state.heldSince = undefined;
    state.midCarriageReturn = false;
    if (state.since !== undefined && !state.discarding) terminate(state, now, out);
    else resetLine(state);
  };
  const pending = (state: LineState) => state.since !== undefined || state.heldSince !== undefined;

  const push = (chunk: LaunchOutput) => {
    const now = chunk.time;
    const out: Array<LogEntry> = [];
    if (chunk.launchId > latest) {
      for (const state of states.values())
        if (state.launchId < chunk.launchId) flushLine(state, now, out);
      latest = chunk.launchId;
      const stale = (launchId: number) => launchId <= latest - retainedLaunches;
      for (const [key, state] of states) if (stale(state.launchId)) states.delete(key);
      for (const launchId of ended) if (stale(launchId)) ended.delete(launchId);
      for (const launchId of ending) if (stale(launchId)) ending.delete(launchId);
      for (const launchId of latestParts.keys()) if (stale(launchId)) latestParts.delete(launchId);
      for (const key of expected.keys())
        if (stale(Number(key.slice(0, key.indexOf(":"))))) expected.delete(key);
      for (const launchId of seen) if (launchId <= latest - seenLaunches) seen.delete(launchId);
    }
    if (!seen.has(chunk.launchId)) {
      seen.add(chunk.launchId);
      out.push({ kind: "launch", timestamp: now, launchId: chunk.launchId });
    }
    const latestPart = latestParts.get(chunk.launchId);
    if (latestPart === undefined || chunk.part > latestPart) {
      for (const state of states.values())
        if (state.launchId === chunk.launchId && state.part < chunk.part)
          flushLine(state, now, out);
      latestParts.set(chunk.launchId, chunk.part);
    }
    const key = `${chunk.launchId}:${chunk.part}:${chunk.stream}`;
    let state = states.get(key);
    if (state === undefined) {
      state = {
        launchId: chunk.launchId,
        part: chunk.part,
        stream: chunk.stream,
        decoder: new TextDecoder(),
        text: "",
        bytes: 0,
        since: undefined,
        held: noBytes,
        heldSince: undefined,
        lastChunk: now,
        midCarriageReturn: false,
        discarding: false,
      };
      states.set(key, state);
    }
    state.lastChunk = now;
    const sequence = `${chunk.launchId}:${chunk.stream}`;
    const next = expected.get(sequence) ?? 0;
    if (chunk.seq > next) {
      out.push({
        kind: "lost",
        timestamp: now,
        launchId: chunk.launchId,
        stream: chunk.stream,
        count: chunk.seq - next,
      });
      resetLine(state);
      state.decoder = new TextDecoder();
      state.held = noBytes;
      state.heldSince = undefined;
      state.midCarriageReturn = false;
    }
    expected.set(sequence, Math.max(next, chunk.seq + 1));
    const carried = state.heldSince;
    const text = state.decoder.decode(chunk.bytes, { stream: true });
    const tail = lastBytes(state.held, chunk.bytes);
    const held = incompleteLength(tail);
    state.held = tail.slice(tail.length - held);
    state.heldSince = held === 0 ? undefined : held > chunk.bytes.length ? (carried ?? now) : now;
    if (text.length > 0) {
      let from = state.midCarriageReturn && text.startsWith("\n") ? 1 : 0;
      state.midCarriageReturn = false;
      let time = carried ?? now;
      const terminator = /\r\n|\r|\n/gu;
      terminator.lastIndex = from;
      for (let match = terminator.exec(text); match !== null; match = terminator.exec(text)) {
        append(state, text.slice(from, match.index), time, out);
        terminate(state, now, out);
        time = now;
        from = match.index + match[0].length;
      }
      append(state, text.slice(from), time, out);
      state.midCarriageReturn = text.endsWith("\r");
    }
    return out;
  };

  const endLaunch = (launchId: number) => {
    if (ended.has(launchId)) return;
    ended.add(launchId);
    ending.add(launchId);
  };

  const flushEnded = (now: number, idle: boolean) => {
    const out: Array<LogEntry> = [];
    for (const state of states.values())
      if (
        ended.has(state.launchId) &&
        pending(state) &&
        ((idle && ending.has(state.launchId)) || now - state.lastChunk >= endedLineGraceMillis)
      )
        flushLine(state, now, out);
    if (idle) ending.clear();
    return out;
  };

  const endedDue = () => {
    if (ending.size > 0) return Number.NEGATIVE_INFINITY;
    let due: number | undefined;
    for (const state of states.values())
      if (ended.has(state.launchId) && pending(state))
        due = Math.min(due ?? Number.POSITIVE_INFINITY, state.lastChunk + endedLineGraceMillis);
    return due;
  };

  const flush = (now: number) => {
    const out: Array<LogEntry> = [];
    for (const state of states.values()) flushLine(state, now, out);
    return out;
  };

  return { push, endLaunch, flushEnded, endedDue, flush };
};
