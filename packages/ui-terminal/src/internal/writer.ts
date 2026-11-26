import type { Size } from "./capabilities.ts";
import { width } from "./width.ts";

const CSI = "\u001b[";
const lineEnd = `${CSI}K\r\n`;
const eraseBelow = `${CSI}J`;
const hideCursor = `${CSI}?25l`;
const showCursor = `${CSI}?25h`;

// oxlint-disable-next-line no-control-regex -- matching the ESC byte of an SGR sequence is the point
const SGR = /\u001b\[[0-9;]*m/g;

const asLines = (lines: ReadonlyArray<string>): string =>
  lines.map((line) => `${line}${lineEnd}`).join("");

/** The one owner of a run's output bytes and cursor state: an inline region below the shell output. */
export interface Writer {
  /** Appends `committed` above the live region and redraws the region, clamped to the screen. */
  readonly draw: (
    committed: ReadonlyArray<string>,
    live: ReadonlyArray<string>,
    size: Size,
  ) => void;
  /** Appends `committed`, draws the whole final frame, leaves the cursor below it and shows it. Does nothing twice. */
  readonly finish: (
    committed: ReadonlyArray<string>,
    live: ReadonlyArray<string>,
    size: Size,
  ) => void;
}

/** Writes through `write`, which must accept the bytes before it returns. */
export const makeWriter = (write: (bytes: string) => void): Writer => {
  // Display width of each row of the last frame, to know how many rows a narrower terminal made of it.
  let widths: ReadonlyArray<number> = [];
  let liveText = "";
  let cursorHidden = false;
  let finished = false;

  const plan = (
    committed: ReadonlyArray<string>,
    live: ReadonlyArray<string>,
    size: Size,
    final: boolean,
  ): void => {
    if (finished) return;
    // The live region leaves the last row to the cursor.
    const room = Math.max(0, size.rows - 1);
    const drawn = final || live.length <= room ? live : live.slice(live.length - room);
    const drawnText = asLines(drawn);
    // A narrower terminal re-wraps the last frame, so it now spans more rows than were drawn.
    const spanned = widths.reduce((rows, w) => rows + Math.max(1, Math.ceil(w / size.columns)), 0);
    // Past the screen height the top of the frame is out of reach, so it stays and a new one is drawn below.
    const anchored = widths.length === 0 || size.rows > spanned;

    if (anchored && committed.length === 0 && drawnText === liveText) {
      if (final) {
        if (cursorHidden) write(showCursor);
        cursorHidden = false;
        finished = true;
      }
      return;
    }

    const erase =
      widths.length === 0
        ? `\r${eraseBelow}`
        : anchored
          ? `\r${CSI}${spanned}A${eraseBelow}`
          : "\r\n";
    const hide = !final && !cursorHidden ? hideCursor : "";
    const show = final && cursorHidden ? showCursor : "";
    write(`${hide}${erase}${asLines([...committed, ...drawn])}${show}`);
    widths = drawn.map((line) => width(line.replace(SGR, "")));
    liveText = drawnText;
    cursorHidden = !final;
    finished = final;
  };

  return {
    draw: (committed, live, size) => plan(committed, live, size, false),
    finish: (committed, live, size) => plan(committed, live, size, true),
  };
};
