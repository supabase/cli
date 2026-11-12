/** A span flattened to the fields the tree builder and renderer need. */
export interface TraceSpanRecord {
  readonly spanId: string;
  readonly parentSpanId: string | undefined;
  readonly label: string;
  readonly startMs: number;
  readonly endMs: number;
  readonly isError: boolean;
}

export interface TraceSpanNode {
  readonly span: TraceSpanRecord;
  readonly children: ReadonlyArray<TraceSpanNode>;
}

const byStart = (a: TraceSpanRecord, b: TraceSpanRecord): number => a.startMs - b.startMs;

/**
 * Builds a span tree from a flat list. A span whose parent is missing, self-referential, or part
 * of a cycle becomes an additional root instead of being dropped — the response can't be trusted
 * to describe a clean tree.
 */
export function buildSpanTree(spans: ReadonlyArray<TraceSpanRecord>): ReadonlyArray<TraceSpanNode> {
  const byId = new Map(spans.map((span) => [span.spanId, span] as const));
  const childrenOf = new Map<string, Array<TraceSpanRecord>>();
  const hasKnownParent = new Set<string>();
  for (const span of spans) {
    if (
      span.parentSpanId !== undefined &&
      span.parentSpanId !== span.spanId &&
      byId.has(span.parentSpanId)
    ) {
      hasKnownParent.add(span.spanId);
      const siblings = childrenOf.get(span.parentSpanId);
      if (siblings) siblings.push(span);
      else childrenOf.set(span.parentSpanId, [span]);
    }
  }

  const visited = new Set<string>();
  const buildNode = (span: TraceSpanRecord): TraceSpanNode => {
    visited.add(span.spanId);
    const children = (childrenOf.get(span.spanId) ?? [])
      .filter((child) => !visited.has(child.spanId))
      .slice()
      .sort(byStart);
    return { span, children: children.map(buildNode) };
  };

  const declaredRoots = spans.filter((span) => !hasKnownParent.has(span.spanId)).sort(byStart);
  const roots = declaredRoots.map(buildNode);
  // A span cut off by a pure cycle never gets visited above; surface it rather than dropping it.
  // Building one stranded root can visit the rest of its cycle, so re-check `visited` per span
  // instead of mapping the whole candidate list up front.
  const strandedRoots: Array<TraceSpanNode> = [];
  for (const span of spans.filter((s) => !visited.has(s.spanId)).sort(byStart)) {
    if (!visited.has(span.spanId)) strandedRoots.push(buildNode(span));
  }
  return [...roots, ...strandedRoots];
}

interface FlattenedSpan {
  readonly span: TraceSpanRecord;
  readonly depth: number;
  readonly isLastChild: boolean;
  readonly ancestorHasMoreSiblings: ReadonlyArray<boolean>;
}

/** Depth-first, pre-order flattening of a tree, carrying the layout info the renderer needs. */
export function flattenSpanTree(nodes: ReadonlyArray<TraceSpanNode>): ReadonlyArray<FlattenedSpan> {
  const out: Array<FlattenedSpan> = [];
  const walk = (
    siblings: ReadonlyArray<TraceSpanNode>,
    depth: number,
    ancestorHasMoreSiblings: ReadonlyArray<boolean>,
  ) => {
    siblings.forEach((node, index) => {
      const isLastChild = index === siblings.length - 1;
      out.push({ span: node.span, depth, isLastChild, ancestorHasMoreSiblings });
      walk(node.children, depth + 1, [...ancestorHasMoreSiblings, !isLastChild]);
    });
  };
  walk(nodes, 0, []);
  return out;
}

export interface TraceSummary {
  readonly spanCount: number;
  readonly startMs: number;
  readonly durationMs: number;
  readonly errorSpanIds: ReadonlyArray<string>;
  readonly slowestNonRootSpanId: string | undefined;
}

/** Summarizes a flattened trace: overall span, trace duration, error spans, and the slowest non-root span. */
export function summarizeTrace(flattened: ReadonlyArray<FlattenedSpan>): TraceSummary {
  if (flattened.length === 0) {
    return {
      spanCount: 0,
      startMs: 0,
      durationMs: 0,
      errorSpanIds: [],
      slowestNonRootSpanId: undefined,
    };
  }
  let startMs = Infinity;
  let endMs = -Infinity;
  const errorSpanIds: Array<string> = [];
  let slowestNonRootSpanId: string | undefined;
  let slowestDuration = -Infinity;
  for (const { span, depth } of flattened) {
    if (span.startMs < startMs) startMs = span.startMs;
    if (span.endMs > endMs) endMs = span.endMs;
    if (span.isError) errorSpanIds.push(span.spanId);
    if (depth > 0) {
      const duration = span.endMs - span.startMs;
      if (duration > slowestDuration) {
        slowestDuration = duration;
        slowestNonRootSpanId = span.spanId;
      }
    }
  }
  return {
    spanCount: flattened.length,
    startMs,
    durationMs: endMs - startMs,
    errorSpanIds,
    slowestNonRootSpanId,
  };
}
