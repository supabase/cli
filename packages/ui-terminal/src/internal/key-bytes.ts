import type { KeyPayload } from "../Terminal.ts";

const named: Readonly<Record<string, string>> = {
  return: "\r",
  tab: "\t",
  escape: "\u001b",
  backspace: "\u007f",
  space: " ",
  up: "\u001b[A",
  down: "\u001b[B",
  right: "\u001b[C",
  left: "\u001b[D",
  home: "\u001b[H",
  end: "\u001b[F",
  delete: "\u001b[3~",
  pageup: "\u001b[5~",
  pagedown: "\u001b[6~",
};

/** The bytes a terminal sends for `key` (a `KeyPayload` name) with the given modifiers. */
export const keyBytes = (key: string, details: Partial<Omit<KeyPayload, "key">> = {}): string => {
  if (key === "tab" && details.shift === true) return "\u001b[Z";
  const base = named[key] ?? (details.shift === true ? key.toUpperCase() : key);
  if (details.ctrl === true && base.length === 1) {
    return String.fromCharCode(base.toUpperCase().charCodeAt(0) & 0x1f);
  }
  return details.option === true ? `\u001b${base}` : base;
};
