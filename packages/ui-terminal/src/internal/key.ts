import { Data } from "effect";

/**
 * A decoded key press. `meta` is present on a key sent as `ESC` followed by that key (Option or
 * Alt as Meta). Navigation and editing keys also carry `shift` and `ctrl` when the terminal reports
 * them through an xterm modifier parameter.
 */
export type Key = Data.TaggedEnum<{
  Char: { readonly text: string; readonly meta?: true };
  Enter: { readonly meta?: true };
  Tab: { readonly meta?: true };
  ShiftTab: {};
  Backspace: { readonly meta?: true };
  Delete: { readonly shift?: true; readonly meta?: true; readonly ctrl?: true };
  Escape: {};
  Up: { readonly shift?: true; readonly meta?: true; readonly ctrl?: true };
  Down: { readonly shift?: true; readonly meta?: true; readonly ctrl?: true };
  Left: { readonly shift?: true; readonly meta?: true; readonly ctrl?: true };
  Right: { readonly shift?: true; readonly meta?: true; readonly ctrl?: true };
  Home: { readonly shift?: true; readonly meta?: true; readonly ctrl?: true };
  End: { readonly shift?: true; readonly meta?: true; readonly ctrl?: true };
  PageUp: { readonly shift?: true; readonly meta?: true; readonly ctrl?: true };
  PageDown: { readonly shift?: true; readonly meta?: true; readonly ctrl?: true };
  Ctrl: { readonly letter: string; readonly meta?: true };
}>;

export const Key = Data.taggedEnum<Key>();
