/**
 * A minimal USTAR writer for the `.tar.gz` build context `supabase compute push`
 * uploads, needed because shelling out to `tar` isn't portable (BSD tar, GNU tar, and no tar
 * at all on Windows produce different bytes for the same directory) and `Bun.Archive` builds
 * from path-to-contents pairs with no per-entry metadata, so symlinks and the executable bit
 * would be lost.
 */

import { Data, Effect } from "effect";
import {
  actionability,
  type CliErrorActionabilityDeclaration,
  ErrorActionabilityId,
} from "../telemetry/error-actionability.ts";

const BLOCK_SIZE = 512;

export interface TarEntry {
  /** Path inside the archive, always `/`-separated and relative. */
  readonly path: string;
  readonly contents: Uint8Array;
  /** Unix mode bits. Defaults to `0o644`. */
  readonly mode?: number;
  /** Modification time in seconds since the epoch. Defaults to `0`. */
  readonly mtime?: number;
  /**
   * Target of a symbolic link. When set the entry is stored as a link rather
   * than as its contents, which is what keeps a symlink-dense tree (anything
   * pnpm installed) from being inlined — and what stops a link to a directory
   * from being walked into.
   */
  readonly linkTarget?: string;
}

/**
 * The largest value an 11-digit octal field can hold: 8 GiB minus one byte for
 * a size, and a little past the year 2242 for an mtime.
 */
const MAX_OCTAL_FIELD = 8 ** 11 - 1;

/**
 * USTAR stores numbers as zero-padded octal followed by a NUL. A value too large for the
 * field spills a digit into the next one — corruption no reader can detect — so this refuses
 * rather than switching to base-256 like real tars do. The range is checked, not just the
 * width, because `(-1)` and `NaN` both render to exactly `length - 1` characters and would
 * otherwise slip through.
 */
const writeOctal = Effect.fnUntraced(function* (
  block: Uint8Array,
  offset: number,
  length: number,
  value: number,
) {
  const digits = Math.floor(value);
  const text = digits.toString(8).padStart(length - 1, "0");
  if (digits < 0 || !Number.isSafeInteger(digits) || text.length > length - 1) {
    return yield* new TarFieldOutOfRangeError({ value });
  }
  writeAscii(block, offset, text);
});

function writeAscii(block: Uint8Array, offset: number, value: string): void {
  for (let index = 0; index < value.length; index++) {
    block[offset + index] = value.charCodeAt(index) & 0xff;
  }
}

/**
 * Split a path into USTAR's `prefix` (155 bytes) and `name` (100 bytes) fields.
 * The split has to fall on a `/`, so a single path component longer than 100
 * bytes cannot be represented at all.
 */
function splitPath(path: string): { name: string; prefix: string } | undefined {
  if (byteLength(path) <= 100) {
    return { name: path, prefix: "" };
  }

  for (let index = path.indexOf("/"); index !== -1; index = path.indexOf("/", index + 1)) {
    const prefix = path.slice(0, index);
    const name = path.slice(index + 1);
    if (byteLength(prefix) <= 155 && byteLength(name) <= 100) {
      return { name, prefix };
    }
  }

  return undefined;
}

const encoder = new TextEncoder();

function byteLength(value: string): number {
  return encoder.encode(value).length;
}

/** A path USTAR cannot represent; typed so push renders an actionable failure. */
export class TarPathTooLongError extends Data.TaggedError("TarPathTooLongError")<{
  readonly path: string;
}> {
  get detail(): string {
    return `"${this.path}" is too long for a tar archive (over 100 bytes with no directory boundary to split on)`;
  }

  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.invalidInput;
  }
}

/**
 * A number USTAR's octal fields cannot hold — see {@link writeOctal}.
 */
export class TarFieldOutOfRangeError extends Data.TaggedError("TarFieldOutOfRangeError")<{
  readonly value: number;
}> {
  get detail(): string {
    return `${this.value} cannot be written to a tar header field (values must be whole numbers from 0 to ${MAX_OCTAL_FIELD})`;
  }

  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.invalidInput;
  }
}

const header = Effect.fnUntraced(function* (
  entry: TarEntry,
  typeflag: "0" | "2" | "5",
  size: number,
) {
  const block = new Uint8Array(BLOCK_SIZE);
  const split = splitPath(entry.path);
  if (split === undefined) {
    return yield* new TarPathTooLongError({ path: entry.path });
  }

  const encodedName = encoder.encode(split.name);
  block.set(encodedName, 0);
  yield* writeOctal(block, 100, 8, entry.mode ?? 0o644);
  yield* writeOctal(block, 108, 8, 0); // uid
  yield* writeOctal(block, 116, 8, 0); // gid
  yield* writeOctal(block, 124, 12, size);
  yield* writeOctal(block, 136, 12, entry.mtime ?? 0);
  // The checksum field is treated as spaces while the checksum is computed.
  block.fill(0x20, 148, 156);
  block[156] = typeflag.charCodeAt(0);
  if (entry.linkTarget !== undefined) {
    const encodedTarget = encoder.encode(entry.linkTarget);
    if (encodedTarget.length > 100) {
      return yield* new TarPathTooLongError({ path: entry.linkTarget });
    }
    block.set(encodedTarget, 157);
  }
  writeAscii(block, 257, "ustar");
  writeAscii(block, 263, "00");
  block.set(encoder.encode(split.prefix), 345);

  let checksum = 0;
  for (const byte of block) {
    checksum += byte;
  }
  // Six octal digits, a NUL, then a space — the form every tar reads.
  writeAscii(block, 148, checksum.toString(8).padStart(6, "0"));
  block[154] = 0;
  block[155] = 0x20;

  return block;
});

function padding(size: number): number {
  const remainder = size % BLOCK_SIZE;
  return remainder === 0 ? 0 : BLOCK_SIZE - remainder;
}

/**
 * Build a USTAR archive from `entries`, in the order given. An entry with a
 * `linkTarget` is stored as a symbolic link, a path ending in `/` as a
 * directory, and everything else as a regular file. The archive ends with the
 * two zero blocks every reader expects.
 */
export const createTar = Effect.fnUntraced(function* (entries: ReadonlyArray<TarEntry>) {
  const blocks: Array<Uint8Array> = [];
  let total = 0;

  const push = (block: Uint8Array) => {
    blocks.push(block);
    total += block.length;
  };

  for (const entry of entries) {
    const isSymlink = entry.linkTarget !== undefined;
    const isDirectory = !isSymlink && entry.path.endsWith("/");
    // A link's target lives in the header, so it carries no content blocks.
    const size = isDirectory || isSymlink ? 0 : entry.contents.length;
    push(yield* header(entry, isSymlink ? "2" : isDirectory ? "5" : "0", size));
    if (size > 0) {
      push(entry.contents);
      const pad = padding(size);
      if (pad > 0) {
        push(new Uint8Array(pad));
      }
    }
  }

  push(new Uint8Array(BLOCK_SIZE * 2));

  const archive = new Uint8Array(total);
  let offset = 0;
  for (const block of blocks) {
    archive.set(block, offset);
    offset += block.length;
  }
  return archive;
});
