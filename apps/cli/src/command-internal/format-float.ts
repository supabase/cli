/**
 * Formats a number in its shortest round-trip form, switching to exponent notation when the
 * decimal exponent is `< -4` or `>= 6` (`1000000` → `1e+06`), with a signed, at-least-two-digit
 * exponent.
 *
 * Shared by `db query`'s value formatter and `postgres-config`'s pretty table.
 */
export function formatGeneralFloat(n: number): string {
  if (Number.isNaN(n)) return "NaN";
  if (!Number.isFinite(n)) return n > 0 ? "+Inf" : "-Inf";
  // Negative zero keeps its sign; `n === 0` is true for both `+0` and `-0`.
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
