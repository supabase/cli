/**
 * A minimal USTAR writer, for the `.tar.gz` build context `supabase workers
 * push` uploads.
 *
 * Shelling out to `tar` would be shorter, but the CLI ships as a single
 * compiled binary to machines where `tar` may be BSD tar, GNU tar, or absent
 * (Windows), and each writes a different archive for the same directory. The
 * server only ever untars what we send, so producing the bytes here keeps the
 * upload identical on every platform and keeps packaging out of the process
 * table.
 */

import {
  actionability,
  type CliErrorActionabilityDeclaration,
  ErrorActionabilityFingerprintId,
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
 * USTAR stores numbers as zero-padded octal followed by a NUL.
 *
 * A value too large for the field renders one digit too long and spills into the
 * next field, producing an archive that reads back with a plausible but wrong
 * size — corruption no reader can detect. Real tars switch to base-256 here;
 * this writer refuses instead, because a build context carrying an 8 GiB file is
 * already a mistake worth naming rather than silently mangling.
 *
 * The range is checked, not just the rendered width, because the width check
 * alone does not catch a value that is not a whole non-negative number:
 * `(-1).toString(8)` is `"-1"` and `NaN.toString(8)` is `"NaN"`, both of which
 * pad to exactly `length - 1` characters and slip through while writing a field
 * no tar can parse.
 */
function writeOctal(block: Uint8Array, offset: number, length: number, value: number): void {
  const digits = Math.floor(value);
  const text = digits.toString(8).padStart(length - 1, "0");
  if (digits < 0 || !Number.isSafeInteger(digits) || text.length > length - 1) {
    throw new TarFieldOutOfRangeError(value);
  }
  writeAscii(block, offset, text);
}

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

/**
 * Thrown for a path USTAR cannot represent. A plain `Error` rather than a
 * tagged one because `createTar` is a pure synchronous function with no Effect
 * semantics of its own; the caller's own error channel is where this surfaces.
 * It is still user-actionable — renaming the offending file fixes it — so it
 * carries its own classification, and the static identifier keeps the
 * fingerprint stable through minification.
 */
export class TarPathTooLongError extends Error {
  static readonly [ErrorActionabilityFingerprintId] = "TarPathTooLongError";

  constructor(path: string) {
    super(
      `"${path}" is too long for a tar archive (over 100 bytes with no directory boundary to split on)`,
    );
    this.name = "TarPathTooLongError";
  }

  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.invalidInput;
  }
}

/**
 * Thrown for a number USTAR's octal fields cannot hold — see {@link writeOctal}.
 * Untagged for the same reason as {@link TarPathTooLongError}: `createTar` is a
 * pure function, and the caller's error channel is where this surfaces.
 */
export class TarFieldOutOfRangeError extends Error {
  static readonly [ErrorActionabilityFingerprintId] = "TarFieldOutOfRangeError";

  constructor(value: number) {
    super(
      `${value} cannot be written to a tar header field (values must be whole numbers from 0 to ${MAX_OCTAL_FIELD})`,
    );
    this.name = "TarFieldOutOfRangeError";
  }

  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.invalidInput;
  }
}

function header(entry: TarEntry, typeflag: "0" | "2" | "5", size: number): Uint8Array {
  const block = new Uint8Array(BLOCK_SIZE);
  const split = splitPath(entry.path);
  if (split === undefined) {
    throw new TarPathTooLongError(entry.path);
  }

  const encodedName = encoder.encode(split.name);
  block.set(encodedName, 0);
  writeOctal(block, 100, 8, entry.mode ?? 0o644);
  writeOctal(block, 108, 8, 0); // uid
  writeOctal(block, 116, 8, 0); // gid
  writeOctal(block, 124, 12, size);
  writeOctal(block, 136, 12, entry.mtime ?? 0);
  // The checksum field is treated as spaces while the checksum is computed.
  block.fill(0x20, 148, 156);
  block[156] = typeflag.charCodeAt(0);
  if (entry.linkTarget !== undefined) {
    const encodedTarget = encoder.encode(entry.linkTarget);
    if (encodedTarget.length > 100) {
      throw new TarPathTooLongError(entry.linkTarget);
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
}

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
export function createTar(entries: ReadonlyArray<TarEntry>): Uint8Array {
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
    push(header(entry, isSymlink ? "2" : isDirectory ? "5" : "0", size));
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
}
