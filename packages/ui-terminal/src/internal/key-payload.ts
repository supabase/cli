import type { KeyPayload } from "../Terminal.ts";
import type { Key } from "./key.ts";

interface Modifiers {
  readonly shift?: true;
  readonly meta?: true;
  readonly ctrl?: true;
}

const press = (
  key: string,
  sequence: string,
  { shift, meta, ctrl }: Modifiers = {},
): KeyPayload => ({
  key,
  sequence,
  ctrl: ctrl === true,
  shift: shift === true,
  meta: false,
  option: meta === true,
  repeat: false,
  editable: false,
});

/** The payload for `key`: names follow OpenTUI's (`return`, `up`, `space`); Alt arrives as `option`. */
export const payloadOf = (key: Key): KeyPayload => {
  switch (key._tag) {
    case "Char": {
      const lower = key.text.toLowerCase();
      const shifted = key.text.length === 1 && lower !== key.text;
      const name = key.text === " " ? "space" : shifted ? lower : key.text;
      return press(name, key.text, { ...key, shift: shifted ? true : undefined });
    }
    case "Ctrl":
      return press(key.letter, "", { ...key, ctrl: true });
    case "Enter":
      return press("return", "\r", key);
    case "Tab":
      return press("tab", "\t", key);
    case "ShiftTab":
      return press("tab", "", { shift: true });
    case "Backspace":
      return press("backspace", "", key);
    case "Escape":
      return press("escape", "");
    case "Delete":
      return press("delete", "", key);
    case "Up":
      return press("up", "", key);
    case "Down":
      return press("down", "", key);
    case "Left":
      return press("left", "", key);
    case "Right":
      return press("right", "", key);
    case "Home":
      return press("home", "", key);
    case "End":
      return press("end", "", key);
    case "PageUp":
      return press("pageup", "", key);
    case "PageDown":
      return press("pagedown", "", key);
  }
};
