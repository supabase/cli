import { Schema } from "effect";
import { defineTaggedUnion } from "foldkit/schema";

const meta = Schema.optionalKey(Schema.Literal(true));
const shift = Schema.optionalKey(Schema.Literal(true));
const ctrl = Schema.optionalKey(Schema.Literal(true));

/**
 * A decoded key press; `Eof` marks the end of the input stream. `meta` is present on a key sent
 * as `ESC` followed by that key (Option or Alt as Meta). Navigation and editing keys also carry
 * `shift` and `ctrl` when the terminal reports them through an xterm modifier parameter.
 */
export const Key = defineTaggedUnion({
  Char: { text: Schema.String, meta },
  Enter: { meta },
  Tab: { meta },
  ShiftTab: {},
  Backspace: { meta },
  Delete: { shift, meta, ctrl },
  Escape: {},
  Up: { shift, meta, ctrl },
  Down: { shift, meta, ctrl },
  Left: { shift, meta, ctrl },
  Right: { shift, meta, ctrl },
  Home: { shift, meta, ctrl },
  End: { shift, meta, ctrl },
  PageUp: { shift, meta, ctrl },
  PageDown: { shift, meta, ctrl },
  Ctrl: { letter: Schema.String, meta },
  Eof: {},
});

export type Key = typeof Key.Type;

/** True for any key pressed with a modifier. */
export const isModified = (key: Key): boolean =>
  key._tag === "Ctrl" ||
  key._tag === "ShiftTab" ||
  ("shift" in key && key.shift === true) ||
  ("meta" in key && key.meta === true) ||
  ("ctrl" in key && key.ctrl === true);
