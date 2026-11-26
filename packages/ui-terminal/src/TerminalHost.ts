import { Component } from "@effect/ui";
import * as Renderer from "@effect/ui/Renderer";
import type * as View from "@effect/ui/View";
import { Cause, Deferred, Effect, Exit, Layer } from "effect";
import type { Scope } from "effect";
import type * as AsyncResult from "effect/reactivity/AsyncResult";
import { Direction, MeasureMode, loadYoga } from "yoga-layout/load";
import type { Yoga } from "yoga-layout/load";

import type { Capabilities } from "./internal/capabilities.ts";
import { payloadOf } from "./internal/key-payload.ts";
import { applyProp, ElementNode, hide, TextNode } from "./internal/node.ts";
import type { HostNode } from "./internal/node.ts";
import { paintTree } from "./internal/paint.ts";
import type { PaintContext } from "./internal/paint.ts";
import { NonInteractive, Service as Transport } from "./internal/transport.ts";
import type { Interface as TransportInterface } from "./internal/transport.ts";
import { makeWriter } from "./internal/writer.ts";
import * as Terminal from "./Terminal.ts";
import * as TerminalSubscription from "./TerminalSubscription.ts";
import * as TerminalTheme from "./TerminalTheme.ts";

export {
  layerProcess,
  make as makeTransport,
  NonInteractive,
  Service as Transport,
} from "./internal/transport.ts";
export type {
  Interface as TransportInterface,
  Streams as TransportStreams,
} from "./internal/transport.ts";

export interface MakeHostOptions {
  readonly yoga: Yoga;
  readonly terminal: TransportInterface;
  readonly theme: TerminalTheme.ThemeSpec;
}

/** The host, the node to mount into, and the two ends of its life. */
export interface MadeHost {
  readonly host: Renderer.Host<HostNode>;
  readonly root: ElementNode;
  /** Draws the final frame, leaves the cursor below it and shows it; later commits do nothing. */
  readonly finish: () => void;
  /** Stops listening for resizes and frees the layout nodes. */
  readonly dispose: () => void;
}

export const makeHost = ({ yoga, terminal, theme }: MakeHostOptions): MadeHost => {
  const { capabilities } = terminal;
  const context: PaintContext = {
    unicode: capabilities.unicode,
    isStyled: capabilities.isStyled,
    colorLevel: capabilities.colorLevel,
    theme,
  };
  const writer = makeWriter(terminal.write);
  const config = yoga.Config.create();
  config.setUseWebDefaults(false);
  config.setPointScaleFactor(0);

  const create = (tag: string): ElementNode => new ElementNode(tag, yoga.Node.create(config));
  const root = create("root");
  const statics = new Set<ElementNode>();
  // Removed nodes wait here until commit, because a move is a remove followed by an insert.
  const detached = new Set<HostNode>();
  let closed = false;

  const detach = (node: HostNode): void => {
    const { parent } = node;
    if (parent === undefined) return;
    const index = parent.children.indexOf(node);
    if (index >= 0) parent.children.splice(index, 1);
    if (node instanceof ElementNode) parent.yoga.removeChild(node.yoga);
    else parent.invalidateText();
    node.parent = undefined;
  };

  const attached = (element: ElementNode): boolean => {
    let current: ElementNode | undefined = element;
    while (current !== undefined) {
      if (current === root) return true;
      current = current.parent;
    }
    return false;
  };

  const layOut = (columns: number): void => {
    root.yoga.setWidth(columns);
    root.yoga.calculateLayout(columns, undefined, Direction.LTR);
  };

  /** Paints each `static` child that has not been written yet, then hides it from layout. */
  const flushStatic = (columns: number): ReadonlyArray<string> => {
    const lines: Array<string> = [];
    let flushed = false;
    for (const element of statics) {
      if (element.freed) {
        statics.delete(element);
        continue;
      }
      if (!attached(element)) continue;
      for (const child of element.children) {
        if (!(child instanceof ElementNode) || child.flushed) continue;
        lines.push(...paintTree(child, context));
        hide(child);
        flushed = true;
      }
    }
    if (flushed) layOut(columns);
    return lines;
  };

  const freeDetached = (): void => {
    for (const node of detached) {
      if (node.parent !== undefined) continue;
      if (node instanceof ElementNode) node.free();
    }
    detached.clear();
  };

  const render = (final: boolean): void => {
    if (closed) return;
    const size = terminal.size();
    // The last column belongs to the cursor, so nothing wraps at the terminal edge.
    const columns = Math.max(1, size.columns - 1);
    layOut(columns);
    const committed = flushStatic(columns);
    const live = paintTree(root, context);
    if (final) {
      closed = true;
      writer.finish(committed, live, size);
    } else {
      writer.draw(committed, live, size);
    }
    freeDetached();
  };

  const stopResizes = terminal.onResize(() => render(false));

  const host: Renderer.Host<HostNode> = {
    createElement(tag) {
      const element = create(tag);
      if (tag === "static") statics.add(element);
      if (tag === "text") {
        element.yoga.setMeasureFunc((offered, widthMode, limit, heightMode) => {
          const text = element.textLines();
          const room = Number.isFinite(offered) ? Math.max(0, Math.floor(offered)) : text.natural;
          const width =
            widthMode === MeasureMode.Undefined
              ? text.natural
              : widthMode === MeasureMode.AtMost
                ? Math.min(text.natural, room)
                : room;
          const count = text.lines(width).length;
          const height =
            heightMode === MeasureMode.Undefined
              ? count
              : heightMode === MeasureMode.AtMost
                ? Math.min(count, limit)
                : limit;
          return { width, height };
        });
      }
      return element;
    },
    createText: (text) => new TextNode(text),
    setText(node, text) {
      if (!(node instanceof TextNode)) return;
      node.text = text;
      node.parent?.invalidateText();
    },
    setAttr() {},
    setProp(node, prop, value) {
      if (node instanceof ElementNode) applyProp(node, prop, value);
    },
    insertBefore(parent, node, ref) {
      if (!(parent instanceof ElementNode)) return;
      detached.delete(node);
      detach(node);
      const siblings = parent.children;
      const found = ref === undefined ? -1 : siblings.indexOf(ref);
      const at = found < 0 ? siblings.length : found;
      siblings.splice(at, 0, node);
      node.parent = parent;
      if (node instanceof ElementNode) {
        const yogaIndex = siblings.slice(0, at).filter((s) => s instanceof ElementNode).length;
        parent.yoga.insertChild(node.yoga, yogaIndex);
      } else {
        parent.invalidateText();
      }
    },
    remove(node) {
      detach(node);
      detached.add(node);
    },
    parentOf: (node) => node.parent,
    nextOf: (node) => node.parent?.children[node.parent.children.indexOf(node) + 1],
    setEvents() {},
    elements: [Terminal.name],
    controlled: new Set(),
    runsMounts: false,
    commit: () => render(false),
  };

  return {
    host,
    root,
    finish: () => render(true),
    dispose: () => {
      closed = true;
      stopResizes();
      root.free();
      freeDetached();
      config.free();
    },
  };
};

/** Options for the host a mount draws with; the theme defaults to `TerminalTheme.Current`. */
export interface RendererOptions {
  readonly theme?: TerminalTheme.ThemeSpec | undefined;
}

/** `TerminalHost.run` shows terminal elements; a root whose vocabulary needs more is rejected here. */
export type TerminalRoot<V> = [Renderer.HostOf<V>] extends [Terminal.Host]
  ? unknown
  : {
      readonly "TerminalHost.run shows terminal elements. This root's vocabulary needs": Renderer.HostOf<V>;
    };

/** A mounted component: its root, and the point where it ends. */
export interface Mounted<out Model, in Msg> {
  readonly root: Renderer.Root<Model, Msg>;
  /**
   * Waits for `TerminalCommand.finish`, draws the final frame and resolves with the root's Model;
   * dies with the view's error if the root crashes.
   */
  readonly finished: Effect.Effect<Model | undefined>;
}

export interface MountOptions<V extends View.Elements, RF = never> {
  readonly fallback?:
    | ((
        failure: AsyncResult.Failure<never, unknown>,
        h: View.WithTags<never, {}, V>,
      ) => View.Content<never, RF>)
    | undefined;
  readonly query?: Renderer.QueryOptions | undefined;
  readonly renderer?: RendererOptions | undefined;
}

const nonInteractiveReason = (capabilities: Capabilities): NonInteractive["reason"] | undefined => {
  if (!capabilities.input.isTTY) return "stdin-not-tty";
  if (!capabilities.output.isTTY) return "stdout-not-tty";
  return capabilities.live ? undefined : "dumb-terminal";
};

type EventSources = {
  readonly [K in keyof TerminalSubscription.TerminalEvents]: (
    listener: (
      payload: TerminalSubscription.GlobalPayload<TerminalSubscription.TerminalEvents[K]>,
      preventDefault: () => void,
    ) => void,
  ) => () => void;
};

const noPreventDefault = () => {};

/** One terminal session: the host, the services a mount needs, and the signal that its component is done. */
interface Session {
  readonly tui: MadeHost;
  readonly services: Layer.Layer<Renderer.Renderer | Terminal.Host>;
  /** Completes on `TerminalCommand.finish` and dies when the root's view crashes. */
  readonly finished: Deferred.Deferred<void>;
}

/**
 * Claims the terminal until the scope closes: raw mode and key decoding, a host that draws inline,
 * and a final frame written on the way out. Ctrl+C interrupts the fiber that opened the session.
 * Fails with `NonInteractive`, before writing anything, unless stdin and stdout are terminals.
 */
const openSession = Effect.fn("Terminal.acquire")(function* (config: RendererOptions | undefined) {
  const terminal = yield* Transport;
  const { capabilities } = terminal;
  const reason = nonInteractiveReason(capabilities);
  if (reason !== undefined) {
    yield* Effect.annotateCurrentSpan("terminal.non_interactive_reason", reason);
    return yield* new NonInteractive({ reason });
  }
  yield* Effect.annotateCurrentSpan({
    "terminal.color_level": capabilities.colorLevel,
    "terminal.unicode": capabilities.unicode,
  });

  const theme = config?.theme ?? (yield* TerminalTheme.Current);
  const yoga = yield* Effect.promise(() => loadYoga());
  const finished = yield* Deferred.make<void>();
  // A `finished` awaited after the scope closed would otherwise wait for a `finish` that cannot come.
  yield* Effect.addFinalizer(() => Deferred.interrupt(finished));
  const opener = yield* Effect.fiber;

  // Raw mode turns Ctrl+C into a byte, so the terminal no longer raises SIGINT for it.
  const keys = yield* terminal.keys;
  const stopListening = keys.listen((key) => {
    if (key._tag === "Ctrl" && key.letter === "c") opener.interruptUnsafe();
  });
  yield* Effect.addFinalizer(() => Effect.sync(stopListening));

  // Separate finalizers, so a failed final write cannot skip freeing the host.
  const tui = yield* Effect.acquireRelease(
    Effect.sync(() => makeHost({ yoga, terminal, theme })),
    ({ dispose }) => Effect.sync(dispose),
  );

  const sources: EventSources = {
    keypress: (listener) =>
      keys.listen((key) =>
        listener({ ...payloadOf(key), defaultPrevented: false }, noPreventDefault),
      ),
    resize: (listener) =>
      terminal.onResize(() => {
        const { columns, rows } = terminal.size();
        listener({ width: columns, height: rows, defaultPrevented: false }, noPreventDefault);
      }),
  };
  const events: TerminalSubscription.GlobalEvents = {
    listen: (event, listener) => sources[event](listener),
  };

  const services = Layer.mergeAll(
    Renderer.layer(tui.host),
    Layer.succeed(Terminal.Host, {
      size: terminal.size,
      finish: () => Deferred.doneUnsafe(finished, Exit.void),
    }),
    Layer.succeed(TerminalSubscription.GlobalEvents, events),
  );
  return { tui, services, finished } satisfies Session;
});

const mountSession = Effect.fn("Terminal.mount")(function* <
  Name extends string,
  Props,
  Model,
  Msg,
  Events,
  R,
  RF = never,
  RP = never,
>(
  component: Component.Members<Name, Props, Model, Msg, Events, R, Terminal.Elements>,
  props: Props | Effect.Effect<Props, never, RP>,
  options: MountOptions<Terminal.Elements, RF> | undefined,
) {
  const session = yield* openSession(options?.renderer);
  // A failed root would otherwise be logged and leave a run waiting for a `Finish` that never comes.
  const root = yield* Renderer.mount(component, props, session.tui.root, {
    ...options,
    fallback: (failure, h) => {
      Deferred.doneUnsafe(session.finished, Exit.die(Cause.squash(failure.cause)));
      return options?.fallback === undefined
        ? h.text.children("The view failed.")
        : options.fallback(failure, h);
    },
  }).pipe(Effect.provide(session.services));
  // Finalizers run last-in first-out, so this draws the frame before the mount's own teardown
  // commits an empty tree; an interrupt keeps the last frame like a normal exit does.
  yield* Effect.addFinalizer(() =>
    Effect.sync(session.tui.finish).pipe(Effect.withSpan("Terminal.restoreScreen")),
  );
  const finished = Deferred.await(session.finished).pipe(
    Effect.andThen(
      Effect.sync(() => {
        session.tui.finish();
        return root.model();
      }),
    ),
  );
  return { root, finished } satisfies Mounted<Model, Msg>;
});

/** Mounts `component` inline below the cursor and keeps the live frame until the scope closes. */
export const mountEffect = <
  Name extends string,
  Props,
  Model,
  Msg,
  Events,
  R,
  RF = never,
  RP = never,
>(
  component: Component.Members<Name, Props, Model, Msg, Events, R, Terminal.Elements>,
  props: Props | Effect.Effect<Props, never, RP>,
  options?: MountOptions<Terminal.Elements, RF>,
): Effect.Effect<
  Mounted<Model, Msg>,
  NonInteractive,
  Exclude<R | RF | RP, Terminal.Host | Renderer.Renderer> | Transport | Scope.Scope
> => mountSession(component, props, options);

/**
 * Mounts `component` inline below the cursor and waits for it to issue `TerminalCommand.finish`,
 * then returns its last Model with the final frame left in the scrollback. Ctrl+C interrupts the
 * run like any interruption; the terminal is restored either way. Fails with `NonInteractive`,
 * before writing anything, unless stdin and stdout are terminals.
 */
export const run = <Name extends string, Props, Model, Msg, Events, R, RF = never, RP = never>(
  component: Component.Members<Name, Props, Model, Msg, Events, R, Terminal.Elements>,
  props: Props | Effect.Effect<Props, never, RP>,
  options?: MountOptions<Terminal.Elements, RF>,
): Effect.Effect<
  Model | undefined,
  NonInteractive,
  Exclude<Exclude<R | RF | RP, Terminal.Host | Renderer.Renderer>, Scope.Scope> | Transport
> =>
  Effect.scoped(
    Effect.flatMap(mountSession(component, props, options), ({ finished }) => finished),
  ).pipe(Effect.withSpan("Terminal.run"));
