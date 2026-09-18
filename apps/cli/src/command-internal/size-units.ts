/**
 * Parses `file_size_limit` config values using `docker/go-units`' `RAMInBytes` grammar
 * (1024-based, case-insensitive, optional trailing `b`) before sending them to service APIs.
 * Shared by `config push` (storage/auth/api/db diffing) and `seed buckets`.
 *
 * @see github.com/docker/go-units@v0.5.0/size.go
 */

const BINARY_MAP: Readonly<Record<string, number>> = {
  k: 1024,
  m: 1024 ** 2,
  g: 1024 ** 3,
  t: 1024 ** 4,
  p: 1024 ** 5,
};

const DIGIT_OR_DOT_OR_SPACE = "0123456789. ";

/**
 * Parses a human-readable RAM size (1024-based, case-insensitive, optional trailing `b`)
 * into bytes. Throws on an unparseable string.
 */
export function ramInBytes(sizeStr: string): number {
  let sep = -1;
  for (let i = 0; i < sizeStr.length; i++) {
    if (DIGIT_OR_DOT_OR_SPACE.includes(sizeStr[i] as string)) sep = i;
  }
  if (sep === -1) {
    throw new Error(`invalid size: '${sizeStr}'`);
  }
  let num: string;
  let sfx: string;
  if (sizeStr[sep] !== " ") {
    num = sizeStr.slice(0, sep + 1);
    sfx = sizeStr.slice(sep + 1);
  } else {
    num = sizeStr.slice(0, sep);
    sfx = sizeStr.slice(sep + 1);
  }
  // JS `Number.parseFloat` silently parses a valid numeric prefix (`1.2.3` → 1.2, `1 2` → 1),
  // so validate the whole numeric part against a strict float grammar first: optional sign, a
  // leading or trailing dot, optional exponent, and single underscores between digits only (no
  // leading/trailing/doubled `_`, none adjacent to `.`/sign). Accepts `.5`, `1.`, `1e6`, `+5`,
  // `1_000`; rejects `1.2.3`, `1 2`, leading space, `0x10`, `_1`, `1_`.
  if (
    !/^[+-]?(?:\d(?:_?\d)*(?:\.(?:\d(?:_?\d)*)?)?|\.\d(?:_?\d)*)([eE][+-]?\d(?:_?\d)*)?$/.test(num)
  ) {
    throw new Error(`invalid size: '${sizeStr}'`);
  }
  // Strip the (already-validated, between-digits) underscores before parsing:
  // JS `Number.parseFloat("1_000")` stops at the underscore (→1), unlike Go.
  const size = Number.parseFloat(num.replace(/_/g, ""));
  // Reject NaN and ±Infinity: an overflowing numeral like `1e309` parses to Infinity in JS,
  // but must fail here rather than flow through as `null` in the request body.
  if (!Number.isFinite(size)) {
    throw new Error(`invalid size: '${sizeStr}'`);
  }
  if (size < 0) {
    throw new Error(`invalid size: '${sizeStr}'`);
  }
  if (sfx.length === 0) {
    return Math.trunc(size);
  }
  if (sfx.length > 3) {
    throw new Error(`invalid suffix: '${sfx}'`);
  }
  sfx = sfx.toLowerCase();
  if (sfx[0] === "b") {
    if (sfx.length > 1) {
      throw new Error(`invalid suffix: '${sfx}'`);
    }
    return Math.trunc(size);
  }
  const mul = BINARY_MAP[sfx[0] as string];
  if (mul === undefined) {
    throw new Error(`invalid suffix: '${sfx}'`);
  }
  // The suffix may have a trailing "b" or "ib" (e.g. KiB or MB).
  if (sfx.length === 2 && sfx[1] !== "b") {
    throw new Error(`invalid suffix: '${sfx}'`);
  }
  if (sfx.length === 3 && sfx.slice(1) !== "ib") {
    throw new Error(`invalid suffix: '${sfx}'`);
  }
  return Math.trunc(size * mul);
}
