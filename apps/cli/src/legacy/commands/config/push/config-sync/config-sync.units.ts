/**
 * Ports of `github.com/docker/go-units` used by Go's `sizeInBytes`
 * (`pkg/config/config.go`). `file_size_limit` config values are parsed with
 * `RAMInBytes` and re-serialised in the diff with `BytesSize` (`sizeInBytes`
 * implements `MarshalText`, so BurntSushi emits a quoted human-readable size,
 * e.g. `"5MiB"`).
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
  const size = Number.parseFloat(num);
  if (Number.isNaN(size)) {
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
