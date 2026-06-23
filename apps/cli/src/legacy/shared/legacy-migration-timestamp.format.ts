/**
 * Port of Go's `utils.FormatTimestampVersion` (`internal/utils/render.go:21`):
 * parse a `YYYYMMDDHHMMSS` migration version with the strict `time.Parse`
 * layout `20060102150405` and reformat it as `YYYY-MM-DD HH:MM:SS`. On any parse
 * failure Go returns the input unchanged, so non-timestamp versions (`0`, `1`,
 * non-numeric, out-of-range dates) pass through verbatim.
 *
 * Pure — no Effect / service dependencies.
 */
export function legacyFormatTimestampVersion(version: string): string {
  const match = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/u.exec(version);
  if (match === null) return version;
  // The regex matched, so groups 1-6 are present.
  const yyyy = match[1]!;
  const mm = match[2]!;
  const dd = match[3]!;
  const hh = match[4]!;
  const min = match[5]!;
  const ss = match[6]!;
  const year = Number(yyyy);
  const month = Number(mm);
  const day = Number(dd);
  const hour = Number(hh);
  const minute = Number(min);
  const second = Number(ss);
  // Range-check each field, then a calendar round-trip so impossible dates
  // (e.g. Feb 30, month 13) fall back to passthrough exactly like Go's
  // `time.Parse`, which errors rather than normalising overflow.
  if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59 || second > 59) {
    return version;
  }
  const date = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return version;
  }
  return `${yyyy}-${mm}-${dd} ${hh}:${min}:${ss}`;
}
