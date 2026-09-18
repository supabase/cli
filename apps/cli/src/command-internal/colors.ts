import { styleText } from "node:util";

/**
 * Structural subset of a write stream that the colour gate inspects. Both
 * `process.stdout`/`process.stderr` and minimal test fakes satisfy it.
 * Under Bun, piped standard streams are plain `Writable`s without
 * `hasColors`, which is itself a correct "no colour" signal.
 */
export interface ColorStream {
  readonly hasColors?: (() => boolean) | undefined;
}

/**
 * Colour-detection gate following the NO_COLOR/CLICOLOR convention the established CLI output
 * uses:
 *
 * 1. `NO_COLOR` non-empty → no colour, beats everything.
 * 2. `CLICOLOR=0` → no colour, unless forced.
 * 3. `CLICOLOR_FORCE` set and not `"0"` → colour even when piped.
 * 4. `CI` non-empty → treated as non-TTY.
 * 5. Otherwise: the stream must be a colour-capable TTY. `hasColors()` is faithful on Bun
 *    TTYs (it also covers `TERM=dumb`) and absent on piped streams.
 *
 * Node's `FORCE_COLOR` is not honored — only the `CLICOLOR*` pair.
 */
function supportsColor(stream: ColorStream): boolean {
  const env = process.env;
  if ((env["NO_COLOR"] ?? "") !== "") return false;
  const clicolorForce = env["CLICOLOR_FORCE"] ?? "";
  const forced = clicolorForce !== "" && clicolorForce !== "0";
  if (env["CLICOLOR"] === "0" && !forced) return false;
  if (forced) return true;
  if ((env["CI"] ?? "") !== "") return false;
  return typeof stream.hasColors === "function" && stream.hasColors();
}

/**
 * Renders plain text when the stream is not a TTY (piped output, CI, tests). Node's
 * `styleText` would handle that via `validateStream`, but Bun (1.3.14, the only runtime the
 * CLI ships on) does not implement it — it styles unconditionally, even when the stream is
 * piped and even under `NO_COLOR=1`. The gate is implemented here instead — see
 * {@link supportsColor} — and `validateStream: false` is passed explicitly so this gate stays
 * authoritative even if a future Bun starts validating.
 *
 * `stream` defaults to `process.stderr` because every call site styles progress/suggestion
 * lines written to stderr. A caller styling content written to stdout (e.g. `status`'s pretty
 * table) must pass `process.stdout` explicitly — otherwise the TTY check runs against the
 * wrong stream, and piping stdout while stderr stays a TTY would corrupt the piped output
 * with ANSI escapes.
 *
 * Uses `"cyan"`, the closest Node `styleText` colour to the established bright-cyan value.
 */
export function aqua(text: string, stream: ColorStream = process.stderr): string {
  return supportsColor(stream) ? styleText("cyan", text, { validateStream: false }) : text;
}

export function bold(text: string, stream: ColorStream = process.stderr): string {
  return supportsColor(stream) ? styleText("bold", text, { validateStream: false }) : text;
}

/** Renders in bright yellow. */
export function yellow(text: string, stream: ColorStream = process.stderr): string {
  return supportsColor(stream) ? styleText("yellow", text, { validateStream: false }) : text;
}

/** Renders in bright red. */
export function red(text: string, stream: ColorStream = process.stderr): string {
  return supportsColor(stream) ? styleText("red", text, { validateStream: false }) : text;
}

/** Renders in bright green. */
export function green(text: string, stream: ColorStream = process.stderr): string {
  return supportsColor(stream) ? styleText("green", text, { validateStream: false }) : text;
}
