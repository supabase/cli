/**
 * Ports of `github.com/docker/go-units` used by Go's `sizeInBytes`
 * (`pkg/config/config.go`). `file_size_limit` config values are parsed with
 * `RAMInBytes` and re-serialised in the diff with `BytesSize` (`sizeInBytes`
 * implements `MarshalText`, so BurntSushi emits a quoted human-readable size,
 * e.g. `"5MiB"`).
 *
 * Shared across the legacy shell: `config push` (storage/auth/api/db diffing)
 * and `seed buckets` (which converts each `[storage.buckets.*].file_size_limit`
 * string to the int64 byte count Go sends in the create/update bucket body).
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

const BINARY_ABBRS = ["B", "KiB", "MiB", "GiB", "TiB", "PiB", "EiB", "ZiB", "YiB"] as const;

const DIGIT_OR_DOT_OR_SPACE = "0123456789. ";

/**
 * Port of `units.RAMInBytes` — parses a human-readable RAM size (1024-based,
 * case-insensitive, optional trailing `b`) into bytes. Throws on an unparseable
 * string (Go returns an error that aborts config load).
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
  // Go's `RAMInBytes` (docker/go-units v0.5.0) hands the WHOLE numeric part to
  // `strconv.ParseFloat`, which rejects a string that isn't a complete float.
  // JS `Number.parseFloat` instead silently parses a valid prefix (`1.2.3` → 1.2,
  // `1 2` → 1), so validate the numeric part against Go's float grammar first:
  // optional sign, a leading OR trailing dot, optional exponent, and single
  // underscores BETWEEN digits (Go 1.13+ literal rule — no leading/trailing/
  // doubled `_`, none adjacent to `.`/sign). The digit group `\d(?:_?\d)*`
  // enforces the underscore placement. This accepts Go-valid forms (`.5`, `1.`,
  // `1e6`, `+5`, `1_000`) and rejects the prefix hazards (`1.2.3`, `1 2`,
  // leading-space, `0x10`, `_1`, `1_`). A negative value is rejected post-parse
  // below (matching Go's `size < 0` check); `1e309`→Infinity by the isFinite check.
  if (
    !/^[+-]?(?:\d(?:_?\d)*(?:\.(?:\d(?:_?\d)*)?)?|\.\d(?:_?\d)*)([eE][+-]?\d(?:_?\d)*)?$/.test(num)
  ) {
    throw new Error(`invalid size: '${sizeStr}'`);
  }
  // Strip the (already-validated, between-digits) underscores before parsing:
  // JS `Number.parseFloat("1_000")` stops at the underscore (→1), unlike Go.
  const size = Number.parseFloat(num.replace(/_/g, ""));
  // Reject NaN and ±Infinity: Go's `strconv.ParseFloat` returns a range error
  // for an overflowing numeral like `1e309` (which JS parses to Infinity), so it
  // must fail config load rather than flow through as `null` in the request body.
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

/**
 * Port of Go's `fmt`-style `%.4g`: at most 4 significant digits, trailing zeros
 * removed, no exponent for the magnitudes `BytesSize` produces (scaled to
 * `[0, 1024)`).
 */
function formatG4(n: number): string {
  if (n === 0) return "0";
  let s = n.toPrecision(4);
  if (s.includes("e") || s.includes("E")) {
    return s;
  }
  if (s.includes(".")) {
    s = s.replace(/0+$/, "").replace(/\.$/, "");
  }
  return s;
}

/** Port of Go `cast.IntToUint`: clamp negative values to 0 (Go takes an `int`, so no truncation). */
export function intToUint(value: number): number {
  return value < 0 ? 0 : value;
}

/** Port of `units.BytesSize` — `CustomSize("%.4g%s", size, 1024, binaryAbbrs)`. */
export function bytesSize(size: number): string {
  let value = size;
  let i = 0;
  const limit = BINARY_ABBRS.length - 1;
  while (value >= 1024 && i < limit) {
    value = value / 1024;
    i++;
  }
  return formatG4(value) + BINARY_ABBRS[i];
}
