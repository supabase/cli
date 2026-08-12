import { styleText } from "node:util";

/**
 * Structural subset of a write stream that the colour gate inspects. Both
 * `process.stdout`/`process.stderr` and minimal test fakes satisfy it.
 * Under Bun, piped standard streams are plain `Writable`s without
 * `hasColors`, which is itself a correct "no colour" signal.
 */
export interface LegacyColorStream {
  readonly hasColors?: (() => boolean) | undefined;
}

/**
 * Port of termenv's colour-profile gate, which is what the established lipgloss default
 * renderer consults (`lipgloss/renderer.go` → `termenv.EnvColorProfile`):
 *
 * 1. `NO_COLOR` non-empty → no colour, beats everything (`EnvNoColor`).
 * 2. `CLICOLOR=0` → no colour, unless forced (`EnvNoColor`).
 * 3. `CLICOLOR_FORCE` set and not `"0"` → colour even when piped (the
 * Ascii→ANSI promotion).
 * 4. `CI` non-empty → treated as non-TTY.
 * 5. Otherwise: the stream must be a colour-capable TTY. `hasColors()` is
 * faithful on Bun TTYs (it also covers `TERM=dumb`) and absent on piped
 * streams.
 *
 * termenv does NOT honor Node's `FORCE_COLOR` — only the `CLICOLOR*` pair —
 * so neither does this gate.
 */
function legacySupportsColor(stream: LegacyColorStream): boolean {
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
 * Ports of `utils.Aqua` / `utils.Bold`.
 *
 * The established behavior uses lipgloss, which auto-detects the output profile and renders **plain**
 * text when the stream is not a TTY (piped output, CI, tests). Node's
 * `styleText` would mirror that via `validateStream`, but Bun (1.3.14, the
 * only runtime the CLI ships on) does not implement `validateStream`: it
 * styles unconditionally, even when the stream is piped and even under
 * `NO_COLOR=1`. The gate is therefore implemented here — see
 * {@link legacySupportsColor} — and `validateStream: false` is passed
 * explicitly so that our gate stays authoritative even if a future Bun starts
 * validating.
 *
 * `stream` defaults to `process.stderr` because every original call site styles
 * progress/suggestion lines written to stderr. A caller styling content that is
 * itself written to **stdout** (e.g. `status`'s pretty table) must pass
 * `process.stdout` explicitly — otherwise the TTY check runs against the wrong
 * stream, and piping stdout while stderr stays a TTY (`supabase status | less`)
 * would corrupt the piped output with ANSI escapes (the same bug class CLI-1546
 * fixed for the progress spinner).
 *
 * lipgloss colour "14" is bright cyan; `"cyan"` is the closest faithful match,
 * matching `branches.prompt.ts`'s existing port of `utils.Aqua`.
 */
export function legacyAqua(text: string, stream: LegacyColorStream = process.stderr): string {
  return legacySupportsColor(stream) ? styleText("cyan", text, { validateStream: false }) : text;
}

export function legacyBold(text: string, stream: LegacyColorStream = process.stderr): string {
  return legacySupportsColor(stream) ? styleText("bold", text, { validateStream: false }) : text;
}

/** Port of `utils.Yellow` — lipgloss colour "11" (bright yellow). */
export function legacyYellow(text: string, stream: LegacyColorStream = process.stderr): string {
  return legacySupportsColor(stream) ? styleText("yellow", text, { validateStream: false }) : text;
}

/** Port of `utils.Red` — lipgloss colour "9" (bright red). */
export function legacyRed(text: string, stream: LegacyColorStream = process.stderr): string {
  return legacySupportsColor(stream) ? styleText("red", text, { validateStream: false }) : text;
}

/** Port of `utils.Green` — lipgloss colour "10" (bright green). */
export function legacyGreen(text: string, stream: LegacyColorStream = process.stderr): string {
  return legacySupportsColor(stream) ? styleText("green", text, { validateStream: false }) : text;
}
