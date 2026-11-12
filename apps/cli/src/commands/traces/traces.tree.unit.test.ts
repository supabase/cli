import { describe, expect, it } from "vitest";

import {
  buildSpanTree,
  flattenSpanTree,
  summarizeTrace,
  type TraceSpanRecord,
} from "./traces.tree.ts";

function span(overrides: Partial<TraceSpanRecord> & { readonly spanId: string }): TraceSpanRecord {
  return {
    parentSpanId: undefined,
    label: overrides.spanId,
    startMs: 0,
    endMs: 1,
    isError: false,
    ...overrides,
  };
}

function ids(nodes: ReturnType<typeof buildSpanTree>): ReadonlyArray<string> {
  return nodes.map((node) => node.span.spanId);
}

describe("buildSpanTree", () => {
  it("nests children under their parent, ordered by start", () => {
    const tree = buildSpanTree([
      span({ spanId: "root", startMs: 0 }),
      span({ spanId: "second-child", parentSpanId: "root", startMs: 20 }),
      span({ spanId: "first-child", parentSpanId: "root", startMs: 10 }),
    ]);

    expect(ids(tree)).toEqual(["root"]);
    expect(ids(tree[0]!.children)).toEqual(["first-child", "second-child"]);
  });

  it("keeps multiple top-level spans as separate roots, ordered by start", () => {
    const tree = buildSpanTree([
      span({ spanId: "b", startMs: 10 }),
      span({ spanId: "a", startMs: 0 }),
    ]);

    expect(ids(tree)).toEqual(["a", "b"]);
  });

  it("surfaces a span whose parent is missing from the response as an extra root", () => {
    const tree = buildSpanTree([
      span({ spanId: "root", startMs: 0 }),
      span({ spanId: "orphan", parentSpanId: "does-not-exist", startMs: 5 }),
    ]);

    expect(ids(tree)).toEqual(["root", "orphan"]);
  });

  it("nests arbitrarily deep", () => {
    const tree = buildSpanTree([
      span({ spanId: "l0", startMs: 0 }),
      span({ spanId: "l1", parentSpanId: "l0", startMs: 1 }),
      span({ spanId: "l2", parentSpanId: "l1", startMs: 2 }),
      span({ spanId: "l3", parentSpanId: "l2", startMs: 3 }),
    ]);

    expect(ids(tree[0]!.children)).toEqual(["l1"]);
    expect(ids(tree[0]!.children[0]!.children)).toEqual(["l2"]);
    expect(ids(tree[0]!.children[0]!.children[0]!.children)).toEqual(["l3"]);
  });

  it("keeps a child nested under its parent even when it started earlier (clock skew)", () => {
    const tree = buildSpanTree([
      span({ spanId: "root", startMs: 10 }),
      span({ spanId: "child", parentSpanId: "root", startMs: 5 }),
    ]);

    expect(ids(tree)).toEqual(["root"]);
    expect(ids(tree[0]!.children)).toEqual(["child"]);
  });

  it("keeps a zero-duration span in the tree", () => {
    const tree = buildSpanTree([span({ spanId: "instant", startMs: 5, endMs: 5 })]);

    expect(tree).toHaveLength(1);
    expect(tree[0]!.span.endMs - tree[0]!.span.startMs).toBe(0);
  });

  it("breaks a parent cycle instead of dropping the spans or recursing forever", () => {
    const tree = buildSpanTree([
      span({ spanId: "a", parentSpanId: "b", startMs: 0 }),
      span({ spanId: "b", parentSpanId: "a", startMs: 1 }),
    ]);

    const flattened = flattenSpanTree(tree).map(({ span: s }) => s.spanId);
    expect(flattened.sort()).toEqual(["a", "b"]);
  });

  it("treats a self-parenting span as a root", () => {
    const tree = buildSpanTree([span({ spanId: "self", parentSpanId: "self", startMs: 0 })]);

    expect(ids(tree)).toEqual(["self"]);
    expect(tree[0]!.children).toHaveLength(0);
  });

  it("renders a 5,000-span trace without pathological slowness", () => {
    const spans: Array<TraceSpanRecord> = [span({ spanId: "root", startMs: 0, endMs: 5000 })];
    for (let i = 1; i < 5000; i++) {
      spans.push(
        span({
          spanId: `span-${i}`,
          parentSpanId:
            `span-${Math.floor(i / 2)}` === "span-0" ? "root" : `span-${Math.floor(i / 2)}`,
          startMs: i,
          endMs: i + 1,
        }),
      );
    }

    const start = performance.now();
    const flattened = flattenSpanTree(buildSpanTree(spans));
    expect(performance.now() - start).toBeLessThan(1000);
    expect(flattened).toHaveLength(5000);
  });
});

describe("summarizeTrace", () => {
  it("computes span count, duration, and start from the earliest and latest spans", () => {
    const tree = buildSpanTree([
      span({ spanId: "root", startMs: 100, endMs: 500 }),
      span({ spanId: "child", parentSpanId: "root", startMs: 150, endMs: 600 }),
    ]);

    const summary = summarizeTrace(flattenSpanTree(tree));
    expect(summary.spanCount).toBe(2);
    expect(summary.startMs).toBe(100);
    expect(summary.durationMs).toBe(500);
  });

  it("lists error span ids in the order they appear in the tree", () => {
    const tree = buildSpanTree([
      span({ spanId: "root", startMs: 0, endMs: 10 }),
      span({ spanId: "ok-child", parentSpanId: "root", startMs: 1, endMs: 2 }),
      span({ spanId: "failing-child", parentSpanId: "root", startMs: 3, endMs: 4, isError: true }),
    ]);

    const summary = summarizeTrace(flattenSpanTree(tree));
    expect(summary.errorSpanIds).toEqual(["failing-child"]);
  });

  it("picks the slowest non-root span, ignoring the root's own duration", () => {
    const tree = buildSpanTree([
      span({ spanId: "root", startMs: 0, endMs: 1000 }),
      span({ spanId: "fast-child", parentSpanId: "root", startMs: 0, endMs: 10 }),
      span({ spanId: "slow-child", parentSpanId: "root", startMs: 0, endMs: 900 }),
    ]);

    const summary = summarizeTrace(flattenSpanTree(tree));
    expect(summary.slowestNonRootSpanId).toBe("slow-child");
  });

  it("has no slowest non-root span when the trace is a single root with no children", () => {
    const tree = buildSpanTree([span({ spanId: "root", startMs: 0, endMs: 10 })]);

    const summary = summarizeTrace(flattenSpanTree(tree));
    expect(summary.slowestNonRootSpanId).toBeUndefined();
  });
});
