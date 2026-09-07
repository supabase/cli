/**
 * Render a number the way Go's `fmt.Sprintf("%v", float64)` (and `%+v` — the
 * `+` flag only affects structs) does. JSON numbers decode to `float64` in Go,
 * so `fmt` uses shortest `%g`: exponent form when the decimal exponent is
 * `< -4` or `>= 6` (e.g. `1000000` → `1e+06`, `1.5e8` → `1.5e+08`, `1e-5` →
 * `1e-05`), fixed notation otherwise. The exponent is signed and at least two
 * digits. JS fixed notation matches Go for the `[-4, 6)` exponent range, so
 * only the exponent cases need reformatting — `toExponential()` (no argument)
 * yields the same shortest round-trip digits Go's strconv produces.
 *
 * Shared by `db query`'s value formatter (`db/query/query.format.ts`) and
 * `postgres-config`'s pretty table (`postgres-config.shared.ts`, Go
 * `get.go:32-35`'s `%+v`).
 */
export function legacyGoFormatFloat(n: number): string {
  if (Number.isNaN(n)) return "NaN";
  if (!Number.isFinite(n)) return n > 0 ? "+Inf" : "-Inf";
  // Go's `%v` preserves the sign of negative zero (`-0`); `n === 0` is true for
  // both `+0` and `-0`, so distinguish them with `Object.is` before the shortcut.
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
