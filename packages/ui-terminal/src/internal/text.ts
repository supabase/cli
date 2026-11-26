import { graphemes, width } from "./width.ts";

const TAB_STOP = 8;
const REPLACEMENT = "�";

const ESCAPE_SEQUENCES = new RegExp(
  [
    String.raw`(?:\u001b\[|\u009b)[0-?]*[ -/]*[@-~]`,
    String.raw`(?:\u001b[\]PX^_]|[\u0090\u0098\u009d\u009e\u009f])[\s\S]*?(?:\u0007|\u001b\\|\u009c|$)`,
    String.raw`\u001bO[ -~]`,
    String.raw`\u001b[ -/]*[0-~]`,
  ].join("|"),
  "gu",
);
// oxlint-disable-next-line no-control-regex -- matching control characters is the point
const CONTROLS = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/gu;
const INVISIBLE_FORMATS = /(?!\u200c|\u200d|[\u{e0020}-\u{e007f}])\p{Cf}/gu;
const EXTENDS_PREVIOUS = /^[\p{Grapheme_Extend}\p{Mc}\u200D]/u;

/**
 * Makes untrusted text safe to measure and write: strips escape sequences, expands tabs from
 * `startColumn` and replaces other controls with U+FFFD. Format characters terminals disagree on
 * are removed, and a combining grapheme at a line start becomes U+FFFD so it cannot extend the
 * glyph before it.
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
