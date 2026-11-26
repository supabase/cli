import type { KeyPayload } from "./Terminal.ts";
import type { GlobalPayload } from "./TerminalSubscription.ts";

/**
 * One row of a shortcut table. `ctrl`, `meta`, `option` default to `false`; `shift` matches either
 * state when omitted; `mod` accepts Ctrl or Meta. Terminals report Alt as `option`, and no key
 * reaches a global handler while `editable` or as a repeat unless the row opts in.
 */
export interface Shortcut<Msg> {
  readonly key: string;
  readonly message: Msg;
  readonly mod?: boolean | undefined;
  readonly shift?: boolean | undefined;
  readonly ctrl?: boolean | undefined;
  readonly option?: boolean | undefined;
  readonly meta?: boolean | undefined;
  readonly whileTyping?: boolean | undefined;
  readonly repeat?: boolean | undefined;
}

/** Turns a table of {@link Shortcut} rows into a pure key handler; the first matching row's `message` wins. */
export const shortcuts =
  <const Rows extends ReadonlyArray<Shortcut<unknown>>>(table: Rows) =>
  (payload: KeyPayload | GlobalPayload<KeyPayload>): Rows[number]["message"] | undefined => {
    if ("defaultPrevented" in payload && payload.defaultPrevented) return undefined;
    for (const shortcut of table) {
      if (
        shortcut.key === payload.key &&
        (shortcut.mod === true
          ? payload.ctrl !== payload.meta
          : payload.ctrl === (shortcut.ctrl ?? false) &&
            payload.meta === (shortcut.meta ?? false)) &&
        payload.option === (shortcut.option ?? false) &&
        (shortcut.shift === undefined || payload.shift === shortcut.shift) &&
        (!payload.editable || shortcut.whileTyping === true) &&
        (!payload.repeat || shortcut.repeat === true)
      ) {
        return shortcut.message;
      }
    }
    return undefined;
  };
