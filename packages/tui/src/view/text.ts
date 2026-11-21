import { graphemes, width } from "./width.ts";

const TAB_STOP = 8;
const REPLACEMENT = "�";

const ESCAPE_SEQUENCES = new RegExp(
  [
    // CSI: ESC [ or C1 CSI, parameter bytes, intermediate bytes, final byte
    String.raw`(?:\u001b\[|\u009b)[0-?]*[ -/]*[@-~]`,
    // OSC, DCS, SOS, PM, APC: string ended by BEL or ST, or by the end of the text
    String.raw`(?:\u001b[\]PX^_]|[\u0090\u0098\u009d\u009e\u009f])[\s\S]*?(?:\u0007|\u001b\\|\u009c|$)`,
    // SS3: ESC O and one character
    String.raw`\u001bO[ -~]`,
    // Other ESC sequences: intermediate bytes then a final byte
    String.raw`\u001b[ -/]*[0-~]`,
  ].join("|"),
  "gu",
);
// oxlint-disable-next-line no-control-regex -- matching control characters is the point
const CONTROLS = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/gu;
const INVISIBLE_FORMATS = /(?!\u200c|\u200d|[\u{e0020}-\u{e007f}])\p{Cf}/gu;
const EXTENDS_PREVIOUS = /^[\p{Grapheme_Extend}\p{Mc}\u200D]/u;

/**
 * Makes untrusted text safe to measure and write: removes complete ANSI escape sequences, turns
 * CR and CRLF into LF, expands tabs to the next multiple of 8 cells from the line start
 * (`startColumn` is the cells already on the first line), and replaces every other C0/C1 control
 * and DEL with U+FFFD. LF is the only control left. Removes format characters (Cf) such
 * as U+200B and U+00AD, whose width terminals disagree on, except ZWNJ, ZWJ and emoji tags.
 * A grapheme with no base at the start of a hard line (a leading variation selector, keycap
 * mark, ZWJ, combining mark or spacing mark) becomes U+FFFD so it cannot extend the glyph before it.
 */
export const normalize = (text: string, startColumn = 0): string => {
  const stripped = text
    .replace(ESCAPE_SEQUENCES, "")
    .replace(/\r\n?/g, "\n")
    .replace(CONTROLS, REPLACEMENT)
    .replace(INVISIBLE_FORMATS, "");
  let column = startColumn;
  let out = "";
  for (const grapheme of graphemes(stripped)) {
    if (grapheme === "\n") {
      column = 0;
      out += grapheme;
    } else if (column === 0 && EXTENDS_PREVIOUS.test(grapheme)) {
      out += REPLACEMENT;
      column += 1;
    } else if (grapheme === "\t") {
      const spaces = TAB_STOP - (column % TAB_STOP);
      out += " ".repeat(spaces);
      column += spaces;
    } else {
      out += grapheme;
      column += width(grapheme);
    }
  }
  return out;
};
