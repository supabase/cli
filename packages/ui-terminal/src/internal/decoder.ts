import { Key } from "./key.ts";

/** Bytes received but not yet resolved into keys: a partial escape sequence or UTF-8 character. */
export interface DecoderState {
  readonly pending: Uint8Array;
}

export interface DecoderResult {
  readonly state: DecoderState;
  readonly keys: ReadonlyArray<Key>;
}

export const initialState: DecoderState = { pending: new Uint8Array(0) };

const ESC = 0x1b;
const maxSequenceLength = 32;
const utf8 = new TextDecoder("utf-8");

type Modifiers = Readonly<{ shift?: true; meta?: true; ctrl?: true }>;

const csiKeys: Readonly<Record<string, (modifiers: Modifiers) => Key>> = {
  A: Key.Up,
  B: Key.Down,
  C: Key.Right,
  D: Key.Left,
  H: Key.Home,
  F: Key.End,
  Z: () => Key.ShiftTab(),
};

const csiTildeKeys: Readonly<Record<string, (modifiers: Modifiers) => Key>> = {
  "1": Key.Home,
  "3": Key.Delete,
  "4": Key.End,
  "5": Key.PageUp,
  "6": Key.PageDown,
  "7": Key.Home,
  "8": Key.End,
};

/** Decodes the xterm modifier parameter: value minus one is a bitmask of shift, alt, ctrl and meta; alt and meta both map to `meta`. */
const csiModifiers = (params: ReadonlyArray<string>): Modifiers => {
  const mask = Math.max(0, Number(params[1] ?? 1) - 1);
  return {
    ...((mask & 1) === 0 ? {} : { shift: true }),
    ...((mask & 10) === 0 ? {} : { meta: true }),
    ...((mask & 4) === 0 ? {} : { ctrl: true }),
  };
};

/** Parameters this decoder understands: decimal numbers separated by `;`, any of them empty. */
const isXtermParams = (params: string): boolean => /^\d*(;\d*)*$/.test(params);

const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

const ss3Keys: Readonly<Record<string, Key>> = {
  A: Key.Up({}),
  B: Key.Down({}),
  C: Key.Right({}),
  D: Key.Left({}),
  H: Key.Home({}),
  F: Key.End({}),
};

const isPrintable = (byte: number): boolean => byte >= 0x20 && byte !== 0x7f;

const utf8Length = (lead: number): number =>
  lead >= 0xf0 ? 4 : lead >= 0xe0 ? 3 : lead >= 0xc0 ? 2 : 1;

/** Length of a trailing UTF-8 sequence that is cut short, or 0 when the text ends cleanly. */
const incompleteUtf8Tail = (bytes: Uint8Array, end: number): number => {
  for (let back = 1; back <= Math.min(3, end); back++) {
    const byte = bytes[end - back] ?? 0;
    if ((byte & 0xc0) === 0x80) continue;
    return utf8Length(byte) > back ? back : 0;
  }
  return 0;
};

type Step =
  | { readonly kind: "key"; readonly keys: ReadonlyArray<Key>; readonly next: number }
  | { readonly kind: "incomplete" };

const metaFlag = (meta: boolean): { readonly meta?: true } => (meta ? { meta: true } : {});

/**
 * Reads the keys at `index`, which is not an ESC: one Char per grapheme of a printable run. After a
 * Meta prefix it reads one key, the first grapheme of the text available.
 */
const readKey = (bytes: Uint8Array, index: number, meta: boolean): Step => {
  const byte = bytes[index] ?? 0;
  const flag = metaFlag(meta);

  if (isPrintable(byte)) {
    let end = index;
    while (end < bytes.length && isPrintable(bytes[end] ?? 0)) end++;
    const readable = end === bytes.length ? end - incompleteUtf8Tail(bytes, end) : end;
    if (readable === index) return { kind: "incomplete" };
    const text = utf8.decode(bytes.subarray(index, readable));
    if (!meta) {
      const keys = Array.from(segmenter.segment(text), ({ segment }) =>
        Key.Char({ text: segment }),
      );
      return { kind: "key", keys, next: readable };
    }
    const segment = Array.from(segmenter.segment(text))[0]?.segment ?? text;
    const next = Array.from(segment).reduce(
      (position) => position + utf8Length(bytes[position] ?? 0),
      index,
    );
    return { kind: "key", keys: [Key.Char({ text: segment, meta: true })], next };
  }

  let next = index + 1;
  if (byte === 0x0d) {
    if (bytes[next] === 0x0a) next++;
    return { kind: "key", keys: [Key.Enter(flag)], next };
  }
  if (byte === 0x0a) return { kind: "key", keys: [Key.Enter(flag)], next };
  if (byte === 0x09) return { kind: "key", keys: [Key.Tab(flag)], next };
  if (byte === 0x7f || byte === 0x08) return { kind: "key", keys: [Key.Backspace(flag)], next };
  if (byte >= 0x01 && byte <= 0x1a) {
    const letter = String.fromCharCode(0x60 + byte);
    return { kind: "key", keys: [Key.Ctrl({ letter, ...flag })], next };
  }
  return { kind: "key", keys: [], next };
};

/** Parses the escape sequence starting at `start`, or reports that more bytes are needed. */
const parseEscape = (bytes: Uint8Array, start: number): Step => {
  const introducer = bytes[start + 1];
  if (introducer === undefined) return { kind: "incomplete" };

  if (introducer === 0x5b || introducer === 0x4f) {
    const first = bytes[start + 2];
    if (first === undefined) return { kind: "incomplete" };
    const startsSequence =
      introducer === 0x5b ? first >= 0x20 && first <= 0x7e : first >= 0x40 && first <= 0x7e;
    if (!startsSequence) {
      const prefix = Key.Char({ text: String.fromCharCode(introducer), meta: true });
      return { kind: "key", keys: [prefix], next: start + 2 };
    }
  }

  if (introducer === 0x5b) {
    let index = start + 2;
    while (index < bytes.length && index - start <= maxSequenceLength) {
      const byte = bytes[index] ?? 0;
      if (byte >= 0x40 && byte <= 0x7e) {
        const params = String.fromCharCode(...bytes.subarray(start + 2, index));
        const final = String.fromCharCode(byte);
        const fields = params.split(";");
        const make = final === "~" ? csiTildeKeys[fields[0] ?? ""] : csiKeys[final];
        const keys =
          make === undefined || !isXtermParams(params) ? [] : [make(csiModifiers(fields))];
        return { kind: "key", keys, next: index + 1 };
      }
      if (byte < 0x20 || byte > 0x3f) return { kind: "key", keys: [], next: index };
      index++;
    }
    return index - start > maxSequenceLength
      ? { kind: "key", keys: [], next: index }
      : { kind: "incomplete" };
  }

  if (introducer === 0x4f) {
    const key = ss3Keys[String.fromCharCode(bytes[start + 2] ?? 0)];
    return { kind: "key", keys: key === undefined ? [] : [key], next: start + 3 };
  }

  if (introducer === ESC) return { kind: "key", keys: [Key.Escape()], next: start + 1 };
  return readKey(bytes, start + 1, true);
};

/** Consumes `bytes`, returning the keys they complete and the unresolved remainder. */
export const feed = (state: DecoderState, bytes: Uint8Array): DecoderResult => {
  const buffer = new Uint8Array(state.pending.length + bytes.length);
  buffer.set(state.pending);
  buffer.set(bytes, state.pending.length);

  const keys: Array<Key> = [];
  let index = 0;
  while (index < buffer.length) {
    const step = buffer[index] === ESC ? parseEscape(buffer, index) : readKey(buffer, index, false);
    if (step.kind === "incomplete") break;
    keys.push(...step.keys);
    index = step.next;
  }

  return { state: { pending: buffer.slice(index) }, keys };
};

/** True while a possible escape sequence is waiting for its next byte. */
export const hasPendingEscape = (state: DecoderState): boolean => state.pending[0] === ESC;

const flushedKeys = (pending: Uint8Array): ReadonlyArray<Key> => {
  if (pending.length === 1) return [Key.Escape()];
  const introducer = pending[1];
  if (pending.length === 2 && (introducer === 0x5b || introducer === 0x4f)) {
    return [Key.Char({ text: String.fromCharCode(introducer), meta: true })];
  }
  return [];
};

/**
 * Resolves a waiting lone ESC into Escape; a bare `ESC [` or `ESC O` is Meta with that character,
 * and a longer partial sequence is dropped.
 */
export const flushEscape = (state: DecoderState): DecoderResult => {
  if (!hasPendingEscape(state)) return { state, keys: [] };
  return { state: initialState, keys: flushedKeys(state.pending) };
};
