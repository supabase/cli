/**
 * Remaining formatting helpers from `github.com/docker/go-units` used by Go's
 * `sizeInBytes` (`pkg/config/config.go`). Parsing is owned by
 * `@supabase/config`; this module only re-serialises byte counts with
 * `BytesSize` and preserves Go's signed-to-unsigned conversion behavior.
 *
 * Shared across the legacy shell: `config push` (storage/auth/api/db diffing)
 * and `seed buckets` (which converts each `[storage.buckets.*].file_size_limit`
 * string to the int64 byte count Go sends in the create/update bucket body).
 *
 * @see github.com/docker/go-units@v0.5.0/size.go
 */

const BINARY_ABBRS = ["B", "KiB", "MiB", "GiB", "TiB", "PiB", "EiB", "ZiB", "YiB"] as const;

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
