import { Effect, Fiber, FiberSet, Queue } from "effect";
import type { Scope } from "effect";

import type { Size } from "../capabilities.ts";
import type * as Terminal from "../terminal/terminal.ts";
import * as Theme from "../theme/theme.ts";
import * as Engine from "../view/engine.ts";
import { layout } from "../view/layout.ts";
import type { Node } from "../view/node.ts";
import { paint } from "../view/paint.ts";
import type { Screen, Viewport } from "../view/screen.ts";

const CSI = "\u001b[";
const lineEnd = `${CSI}K\r\n`;
const eraseBelow = `${CSI}J`;
const hideCursor = `${CSI}?25l`;
const showCursor = `${CSI}?25h`;

type Kind = "redraw" | "finish";

interface WriterState {
  committed: number;
  height: number;
  drawnColumns: number;
  liveText: string;
  cursorHidden: boolean;
  finished: boolean;
}

/** Bytes to write, and the state that holds once the terminal has accepted them. */
interface Plan {
  readonly bytes: string;
  readonly attributes: Readonly<Record<string, unknown>>;
  readonly next: Partial<WriterState>;
}

/** Builds the screen for the viewport the writer lays it out at. */
export type ScreenFor = (viewport: Viewport) => Screen;

/** The one owner of a run's output bytes and cursor state. */
export interface SessionWriter {
  /**
   * Offers the latest view; one that was not drawn yet is replaced. It is built in the
   * transaction that writes it, so it sees the terminal size at that moment.
   */
  readonly publish: (screenFor: ScreenFor) => void;
  /**
   * Stops the render loop, awaits the outstanding write, then draws the final frame, building it
   * for the viewport sampled for that frame's own transaction.
   */
  readonly finish: (screenFor: ScreenFor) => Effect.Effect<void, Terminal.TerminalError>;
  /** Best-effort exit for failure and interruption: the final frame, the cursor, a drain of accepted writes. */
  readonly teardown: (screenFor: ScreenFor) => Effect.Effect<void>;
  /** After this, no further `write` is submitted by this session. */
  readonly revoke: Effect.Effect<void>;
  /** Fails with the render loop's write failure; never succeeds. */
  readonly failure: Effect.Effect<never, Terminal.TerminalError>;
}

/** The live region leaves the last column and row to the cursor. */
const liveViewport = (size: Size): Viewport => ({
  columns: Math.max(1, size.columns - 1),
  rows: Math.max(0, size.rows - 1),
});

const asLines = (lines: ReadonlyArray<string>) => lines.map((line) => `${line}${lineEnd}`).join("");

export const makeSessionWriter = Effect.fn("Tui.writer.make")(function* (
  terminal: Terminal.Interface,
  engine: Engine.Engine,
) {
  const { capabilities } = terminal;
  const theme = yield* Theme.Current;
  const renderLines = (node: Node, columns: number): ReadonlyArray<string> =>
    layout(node, { columns, unicode: capabilities.unicode, engine }).map((line) =>
      paint(line, { isStyled: capabilities.isStyled, colorLevel: capabilities.colorLevel, theme }),
    );

  // Plain output lays out at the width fixed at startup, since nothing redraws it.
  const viewportFor = (size: Size): Viewport =>
    capabilities.live
      ? liveViewport(size)
      : { columns: capabilities.output.columns, rows: size.rows };

  const writes = yield* FiberSet.make<void, Terminal.TerminalError>();
  const pending = yield* Queue.sliding<ScreenFor>(1);
  let permit = true;
  let lastWrite: Fiber.Fiber<void, Terminal.TerminalError> | undefined;
  let cursorHiddenWhenDrained = false;

  const state: WriterState = {
    committed: 0,
    height: 0,
    drawnColumns: 0,
    liveText: "",
    cursorHidden: false,
    finished: false,
  };

  const planLive = (
    screen: Screen,
    kind: Kind,
    { current: size, smallest }: Terminal.Geometry,
    viewport: Viewport,
  ): Plan => {
    const final = kind === "finish";
    const { columns: width, rows } = viewport;
    const fresh = screen.committed.slice(state.committed);
    const committedLines = fresh.flatMap((node) => renderLines(node, width));
    const fullLive = renderLines(screen.live, width);
    const clamped = fullLive.length > rows ? fullLive.slice(fullLive.length - rows) : fullLive;
    const drawn = final ? fullLive : clamped;
    const drawnText = asLines(drawn);
    const anchored =
      state.height === 0 ||
      (smallest.columns >= state.drawnColumns && smallest.rows > state.height);
    const fallback = state.height > 0 && !anchored;
    const attributes = {
      "tui.writer.kind": kind,
      "tui.writer.committed": fresh.length,
      "tui.writer.lines": clamped.length,
      "tui.writer.fallback": fallback,
    };

    if (anchored && fresh.length === 0 && drawnText === state.liveText) {
      return {
        bytes: final && state.cursorHidden ? showCursor : "",
        attributes: { ...attributes, "tui.writer.skipped": true },
        next: final ? { finished: true, cursorHidden: false } : {},
      };
    }

    const erase =
      state.height === 0
        ? `\r${eraseBelow}`
        : anchored
          ? `\r${CSI}${state.height}A${eraseBelow}`
          : "\r\n";
    const hide = !final && !state.cursorHidden ? hideCursor : "";
    const show = final && state.cursorHidden ? showCursor : "";

    return {
      bytes: `${hide}${erase}${asLines([...committedLines, ...drawn])}${show}`,
      attributes,
      next: {
        committed: screen.committed.length,
        height: drawn.length,
        drawnColumns: size.columns,
        liveText: drawnText,
        finished: final || state.finished,
        cursorHidden: !final,
      },
    };
  };

  const planPlain = (screen: Screen, kind: Kind, { columns }: Viewport): Plan => {
    const final = kind === "finish";
    const fresh = screen.committed.slice(state.committed);
    const lines = [
      ...fresh.flatMap((node) => renderLines(node, columns)),
      ...(final ? renderLines(screen.live, columns) : []),
    ];
    return {
      bytes: lines.map((line) => `${line}\n`).join(""),
      attributes: {
        "tui.writer.kind": kind,
        "tui.writer.committed": fresh.length,
        "tui.writer.lines": lines.length,
      },
      next: { committed: screen.committed.length, finished: final || state.finished },
    };
  };

  const submit = Effect.fnUntraced(function* (bytes: string, next: Partial<WriterState>) {
    cursorHiddenWhenDrained = next.cursorHidden ?? cursorHiddenWhenDrained;
    const write = yield* FiberSet.run(
      writes,
      Effect.suspend(() =>
        permit
          ? terminal
              .write(bytes)
              .pipe(Effect.tap(() => Effect.sync(() => Object.assign(state, next))))
          : Effect.void,
      ),
    );
    lastWrite = write;
    return write;
  });

  const joinLastWrite = Effect.suspend(() =>
    lastWrite === undefined ? Effect.void : Fiber.join(lastWrite),
  );

  /**
   * Plans from current state and hands the bytes to the terminal as one uninterruptible step. The
   * planned state is applied once the stream accepts the bytes, so a failed write leaves the state
   * describing what is on screen. Only the wait for the write can be interrupted; the write itself
   * runs on in `writes`.
   */
  const transact = (screenFor: ScreenFor, kind: Kind) =>
    Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        const geometry = yield* terminal.sampleGeometry;
        const viewport = viewportFor(geometry.current);
        const screen = screenFor(viewport);
        if (screen.committed.length < state.committed) {
          return yield* Effect.die(
            new Error("Screen.committed is append-only: an entry was removed between frames"),
          );
        }
        const plan = capabilities.live
          ? planLive(screen, kind, geometry, viewport)
          : planPlain(screen, kind, viewport);
        yield* Effect.annotateCurrentSpan({
          ...plan.attributes,
          "tui.writer.bytes": plan.bytes.length,
        });
        if (plan.bytes === "") {
          Object.assign(state, plan.next);
          return;
        }
        const write = yield* submit(plan.bytes, plan.next);
        yield* restore(Fiber.join(write));
      }),
    ).pipe(Effect.withSpan("Tui.writer.transaction"));

  const loop: Fiber.Fiber<never, Terminal.TerminalError> = yield* Queue.take(pending).pipe(
    Effect.flatMap((screenFor) => transact(screenFor, "redraw")),
    Effect.forever,
    Effect.forkScoped({ startImmediately: true }),
  );

  const publish = (screenFor: ScreenFor) => {
    Queue.offerUnsafe(pending, screenFor);
  };

  const finish = Effect.fn("Tui.writer.finish")(function* (screenFor: ScreenFor) {
    yield* Fiber.interrupt(loop);
    yield* joinLastWrite;
    yield* transact(screenFor, "finish");
    yield* joinLastWrite;
  });

  const restoreCursor = Effect.suspend(() => {
    if (!state.cursorHidden) return Effect.void;
    return Effect.asVoid(submit(showCursor, { cursorHidden: false }));
  });

  const settleWrites = Effect.andThen(restoreCursor, FiberSet.awaitEmpty(writes));

  // The stream keeps writes in order, so a cursor restore queued behind a redraw that never
  // completes still lands whenever that redraw drains.
  const queueCursorBehindPendingWrite = Effect.suspend(() =>
    lastWrite === undefined || lastWrite.pollUnsafe() !== undefined || !cursorHiddenWhenDrained
      ? Effect.void
      : Effect.asVoid(submit(showCursor, { cursorHidden: false })),
  );

  const teardown = Effect.fn("Tui.writer.teardown")(function* (screenFor: ScreenFor) {
    // Best effort: a broken terminal or view must not turn the teardown into a second failure.
    yield* Effect.ignoreCause(
      Effect.gen(function* () {
        yield* Fiber.interrupt(loop);
        yield* queueCursorBehindPendingWrite;
        yield* Effect.ignore(joinLastWrite);
        if (!state.finished) yield* transact(screenFor, "finish");
      }),
    );
    yield* settleWrites;
    // A write that failed while settling leaves the cursor hidden, so it is shown again.
    yield* settleWrites;
  });

  return {
    publish,
    finish,
    teardown,
    revoke: Effect.sync(() => {
      permit = false;
    }),
    failure: Fiber.join(loop),
  } satisfies SessionWriter;
}) satisfies (
  terminal: Terminal.Interface,
  engine: Engine.Engine,
) => Effect.Effect<SessionWriter, never, Scope.Scope>;
