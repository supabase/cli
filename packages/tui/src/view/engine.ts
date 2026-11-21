import { Effect } from "effect";
import {
  Align as YogaAlign,
  Direction,
  Edge,
  FlexDirection,
  Gutter,
  Justify as YogaJustify,
  loadYoga,
  MeasureMode as YogaMeasureMode,
  Wrap,
} from "yoga-layout/load";
import type { Node as YogaNode, Yoga } from "yoga-layout/load";

import { Node } from "./node.ts";
import type { AlignSelf, BoxNode, Justify, TextNode } from "./node.ts";

/** The loaded flexbox engine; only this module knows what it is. */
export interface Engine {
  readonly yoga: Yoga;
}

/** Loads the engine; a failure to instantiate it is a defect. */
export const load: Effect.Effect<Engine> = Effect.promise(() => loadYoga()).pipe(
  Effect.map((yoga): Engine => ({ yoga })),
  Effect.withSpan("Tui.loadLayoutEngine"),
);

/** How much room the engine offers a text leaf along one axis. */
type MeasureMode = "undefined" | "exactly" | "at-most";

interface Measured {
  readonly width: number;
  readonly height: number;
}

/** Sizes a text leaf for the room offered; an offer is NaN when its mode is `undefined`. */
export type MeasureText = (
  text: TextNode,
  width: number,
  widthMode: MeasureMode,
  height: number,
  heightMode: MeasureMode,
) => Measured;

/** A node's computed box: relative to its parent and not rounded. */
export interface Placed {
  readonly node: BoxNode | TextNode;
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
  readonly children: ReadonlyArray<Placed>;
}

const justifications: Readonly<Record<Justify, YogaJustify>> = {
  start: YogaJustify.FlexStart,
  center: YogaJustify.Center,
  end: YogaJustify.FlexEnd,
  "space-between": YogaJustify.SpaceBetween,
  "space-around": YogaJustify.SpaceAround,
  "space-evenly": YogaJustify.SpaceEvenly,
};

const alignments: Readonly<Record<AlignSelf, YogaAlign>> = {
  auto: YogaAlign.Auto,
  start: YogaAlign.FlexStart,
  center: YogaAlign.Center,
  end: YogaAlign.FlexEnd,
  stretch: YogaAlign.Stretch,
};

const measureModes: Readonly<Record<YogaMeasureMode, MeasureMode>> = {
  [YogaMeasureMode.Undefined]: "undefined",
  [YogaMeasureMode.Exactly]: "exactly",
  [YogaMeasureMode.AtMost]: "at-most",
};

const clamp = (value: number): number => (Number.isFinite(value) ? Math.max(0, value) : 0);

interface Built {
  readonly yoga: YogaNode;
  readonly source: BoxNode | TextNode;
  readonly children: ReadonlyArray<Built>;
}

const applyBox = (yoga: YogaNode, box: BoxNode): void => {
  yoga.setFlexDirection(box.direction === "row" ? FlexDirection.Row : FlexDirection.Column);
  yoga.setFlexWrap(box.wrap ? Wrap.Wrap : Wrap.NoWrap);
  yoga.setGap(Gutter.All, clamp(box.gap));
  yoga.setFlexGrow(clamp(box.grow));
  yoga.setFlexShrink(clamp(box.shrink));
  yoga.setPadding(Edge.Top, clamp(box.padding.top));
  yoga.setPadding(Edge.Right, clamp(box.padding.right));
  yoga.setPadding(Edge.Bottom, clamp(box.padding.bottom));
  yoga.setPadding(Edge.Left, clamp(box.padding.left));
  if (box.border !== undefined) yoga.setBorder(Edge.All, 1);
  if (typeof box.width === "number") yoga.setWidth(clamp(box.width));
  else if (box.width !== undefined) yoga.setWidthPercent(clamp(Number.parseFloat(box.width)));
  if (box.minWidth !== undefined) yoga.setMinWidth(clamp(box.minWidth));
  if (box.maxWidth !== undefined) yoga.setMaxWidth(clamp(box.maxWidth));
  if (box.height !== undefined) yoga.setHeight(clamp(box.height));
  if (box.minHeight !== undefined) yoga.setMinHeight(clamp(box.minHeight));
  if (box.maxHeight !== undefined) yoga.setMaxHeight(clamp(box.maxHeight));
  if (box.basis !== undefined) yoga.setFlexBasis(clamp(box.basis));
  if (box.justify !== undefined) yoga.setJustifyContent(justifications[box.justify]);
  if (box.align !== undefined) yoga.setAlignItems(alignments[box.align]);
  if (box.alignSelf !== undefined) yoga.setAlignSelf(alignments[box.alignSelf]);
};

const place = (built: Built): Placed => ({
  node: built.source,
  left: built.yoga.getComputedLeft(),
  top: built.yoga.getComputedTop(),
  width: built.yoga.getComputedWidth(),
  height: built.yoga.getComputedHeight(),
  children: built.children.map(place),
});

/**
 * Computes the flexbox layout of `node` inside a column `columns` cells wide and returns its
 * placement, or `undefined` for an `Empty` node. Rounding is left to the caller: the engine's own
 * is off. Every engine node is freed before returning, including after a failure.
 */
export const compute = (
  { yoga }: Engine,
  node: Node,
  columns: number,
  measure: MeasureText,
): Placed | undefined => {
  const config = yoga.Config.create();
  const created: Array<YogaNode> = [];
  const create = (): YogaNode => {
    const made = yoga.Node.create(config);
    created.push(made);
    return made;
  };

  const build = (current: Node): Built | undefined =>
    Node.$match(current, {
      Empty: () => undefined,
      Text: (text) => {
        const leaf = create();
        leaf.setFlexGrow(0);
        leaf.setFlexShrink(1);
        leaf.setMeasureFunc((width, widthMode, height, heightMode) =>
          measure(text, width, measureModes[widthMode], height, measureModes[heightMode]),
        );
        return { yoga: leaf, source: text, children: [] };
      },
      Box: (box) => {
        const parent = create();
        applyBox(parent, box);
        const children: Array<Built> = [];
        for (const child of box.children) {
          const built = build(child);
          if (built === undefined) continue;
          parent.insertChild(built.yoga, children.length);
          children.push(built);
        }
        return { yoga: parent, source: box, children };
      },
    });

  try {
    config.setUseWebDefaults(false);
    config.setPointScaleFactor(0);
    const root = create();
    root.setFlexDirection(FlexDirection.Column);
    root.setWidth(columns);
    const built = build(node);
    if (built === undefined) return undefined;
    root.insertChild(built.yoga, 0);
    root.calculateLayout(columns, undefined, Direction.LTR);
    return place(built);
  } finally {
    for (const made of created) made.free();
    config.free();
  }
};
