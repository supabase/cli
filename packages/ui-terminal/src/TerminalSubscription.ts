import { Subscription } from "@effect/ui";
import type { View } from "@effect/ui";
import { Cause, Context } from "effect";

import type { KeyPayload, ResizePayload } from "./Terminal.ts";
import * as TerminalKeyboard from "./TerminalKeyboard.ts";

/** The events a global Subscription can listen for. */
export interface TerminalEvents {
  readonly keypress: KeyPayload;
  readonly resize: ResizePayload;
}

/** A payload plus whether an earlier handler already claimed it; the terminal never sets it. */
export type GlobalPayload<P> = P & { readonly defaultPrevented: boolean };

/** The event source `onKeyPress` and `onResize` subscribe to; every terminal mount provides the terminal's. */
export interface GlobalEvents {
  readonly listen: <K extends keyof TerminalEvents>(
    event: K,
    listener: (payload: GlobalPayload<TerminalEvents[K]>, preventDefault: () => void) => void,
  ) => () => void;
}

const silent: GlobalEvents = { listen: () => () => {} };

export const GlobalEvents: Context.Reference<GlobalEvents> = Context.Reference<GlobalEvents>(
  "@supabase/ui-terminal/TerminalSubscription/GlobalEvents",
  { defaultValue: () => silent },
);

const isFunction = <Msg, Payload>(
  handler: View.Handler<Msg, Payload>,
): handler is (payload: Payload) => Msg | undefined => typeof handler === "function";

const listenFor = <K extends keyof TerminalEvents, Msg>(
  event: K,
  handler: View.Handler<Msg, GlobalPayload<TerminalEvents[K]>>,
): Subscription.Subscription<Msg> =>
  Subscription.direct<{ readonly handler: typeof handler }, Msg>(
    "@supabase/ui-terminal/terminal",
    event,
    { handler },
    (context, { emit, enter, fail }) =>
      Context.get(context, GlobalEvents).listen(event, (payload) =>
        enter((latest) => {
          try {
            const message = isFunction(latest.handler) ? latest.handler(payload) : latest.handler;
            if (message !== undefined) emit(message);
          } catch (error) {
            fail(Cause.die(error));
          }
        }),
      ),
  );

/** Sends a message for each key press; `undefined` from a handler function ignores the key. */
export const onKeyPress = <Msg>(
  handler: View.Handler<Msg, GlobalPayload<KeyPayload>>,
): Subscription.Subscription<Msg> => listenFor("keypress", handler);

/** Sends a message each time the terminal is resized. */
export const onResize = <Msg>(
  handler: View.Handler<Msg, GlobalPayload<ResizePayload>>,
): Subscription.Subscription<Msg> => listenFor("resize", handler);

/** A key Subscription over a table of shortcuts: the first row whose key and modifiers match wins. */
export const shortcuts = <const Rows extends ReadonlyArray<TerminalKeyboard.Shortcut<unknown>>>(
  table: Rows,
): Subscription.Subscription<Rows[number]["message"]> =>
  onKeyPress(TerminalKeyboard.shortcuts(table));
