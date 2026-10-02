/**
 * Formats a number the way Go's `fmt.Sprintf("%v", float64)` does: shortest `%g`, exponent
 * notation when the decimal exponent is `< -4` or `>= 6` (`1000000` → `1e+06`), fixed notation
 * otherwise, with a signed, at-least-two-digit exponent.
 *
 * Shared by `db query`'s value formatter and `postgres-config`'s pretty table.
 */
export function goFormatFloat(n: number): string {
  if (Number.isNaN(n)) return "NaN";
  if (!Number.isFinite(n)) return n > 0 ? "+Inf" : "-Inf";
  // Go's `%v` preserves the sign of negative zero; `n === 0` is true for both `+0` and `-0`.
  if (Object.is(n, -0)) return "-0";
  if (n === 0) return "0";
  const neg = n < 0;
  const abs = Math.abs(n);
  const [mantissa, eRaw] = abs.toExponential().split("e");
  const exp = Number.parseInt(eRaw!, 10);
  let out: string;
  if (exp < -4 || exp >= 6) {
    const mag = Math.abs(exp).toString().padStart(2, "0");
    out = `${mantissa}e${exp < 0 ? "-" : "+"}${mag}`;
  } else {
    out = abs.toString();
  }
  return neg ? `-${out}` : out;
}
