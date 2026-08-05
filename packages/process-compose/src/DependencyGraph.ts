import { Effect, Graph } from "effect";
import type { DependencyCondition, ServiceDef } from "./ServiceDef.ts";
import { CyclicDependencyError, MissingDependencyError } from "./errors.ts";

export interface ResolvedGraph {
  readonly startOrder: ReadonlyArray<ServiceDef>;
  readonly stopOrder: ReadonlyArray<ServiceDef>;
  readonly startOrderFor: (name: string) => ReadonlyArray<ServiceDef>;
  readonly dependenciesOf: (
    name: string,
  ) => ReadonlyArray<{ def: ServiceDef; condition: DependencyCondition }>;
  readonly dependentsOf: (name: string) => ReadonlyArray<ServiceDef>;
}

/**
 * Builds a resolved dependency graph from a list of service definitions.
 *
 * Filters out disabled services, validates all dependency references exist,
 * detects cycles, and computes start/stop ordering via topological sort.
 *
 * Fails with:
 * - `MissingDependencyError` if a dependency references a non-existent service
 * - `CyclicDependencyError` if the graph contains a cycle
 */
export const buildGraph = (
  services: ReadonlyArray<ServiceDef>,
): Effect.Effect<ResolvedGraph, CyclicDependencyError | MissingDependencyError> =>
  Effect.gen(function* () {
    // Filter out disabled services
    const enabled = services.filter((s) => s.enabled !== false);

    // Build the directed graph
    // Edge direction: FROM dependency TO dependent
    // This ensures topo sort yields dependencies before their dependents
    const nodeByName = new Map<string, Graph.NodeIndex>();
    const serviceByNode = new Map<Graph.NodeIndex, ServiceDef>();

    let missingDepError: MissingDependencyError | undefined;

    const graph = Graph.directed<ServiceDef, DependencyCondition>((mutable) => {
      // Add all enabled services as nodes
      for (const svc of enabled) {
        const idx = Graph.addNode(mutable, svc);
        nodeByName.set(svc.name, idx);
        serviceByNode.set(idx, svc);
      }

      // Add edges: dependency -> dependent
      for (const svc of enabled) {
        const deps = svc.dependencies ?? [];
        for (const dep of deps) {
          const depIdx = nodeByName.get(dep.service);
          if (depIdx === undefined) {
            missingDepError = new MissingDependencyError({
              service: svc.name,
              dependency: dep.service,
            });
            return;
          }
          const svcIdx = nodeByName.get(svc.name)!;
          // Edge: depIdx (dep) -> svcIdx (dependent)
          Graph.addEdge(mutable, depIdx, svcIdx, dep.condition);
        }
      }
    });

    if (missingDepError !== undefined) {
      yield* Effect.fail(missingDepError);
    }

    // Check for cycles before calling topo (which would throw a generic GraphError)
    if (!Graph.isAcyclic(graph)) {
      // Find nodes involved in cycle for the error message
      const cycleNodes: Array<string> = [];
      for (const [, svc] of Graph.nodes(graph)) {
        cycleNodes.push(svc.name);
      }
      yield* Effect.fail(new CyclicDependencyError({ cycle: cycleNodes.join(" -> ") }));
    }

    // Compute start order via topological sort (yields dependencies first)
    const startOrder: Array<ServiceDef> = Array.from(Graph.values(Graph.topo(graph)));

    // Stop order is reverse of start order
    const stopOrder: Array<ServiceDef> = [...startOrder].reverse();

    // Map from name to NodeIndex for quick lookup
    const getNodeIndex = (name: string): Graph.NodeIndex | undefined => nodeByName.get(name);

    const startOrderFor = (name: string): ReadonlyArray<ServiceDef> => {
      const nodeIdx = getNodeIndex(name);
      if (nodeIdx === undefined) return [];

      // Collect all transitive dependencies by following "incoming" edges
      // (edges point FROM dep TO dependent, so "incoming" from a node finds its deps)
      const reachable = new Set<Graph.NodeIndex>();

      // DFS traversal following incoming edges to find all transitive deps
      const stack = [nodeIdx];
      while (stack.length > 0) {
        const current = stack.pop()!;
        if (reachable.has(current)) continue;
        reachable.add(current);

        // Edges point from dependency to dependent, so predecessors are dependencies.
        stack.push(...Graph.predecessors(graph, current));
      }

      // Return the nodes in the reachable set, in start order
      return startOrder.filter((svc) => {
        const idx = getNodeIndex(svc.name);
        return idx !== undefined && reachable.has(idx);
      });
    };

    const dependenciesOf = (
      name: string,
    ): ReadonlyArray<{ def: ServiceDef; condition: DependencyCondition }> => {
      const nodeIdx = getNodeIndex(name);
      if (nodeIdx === undefined) return [];

      // Direct dependencies: follow incoming edges from this node
      const result: Array<{ def: ServiceDef; condition: DependencyCondition }> = [];
      for (const [, edge] of Graph.edges(graph)) {
        if (edge.target !== nodeIdx) continue;
        const depDef = serviceByNode.get(edge.source);
        if (depDef !== undefined) {
          result.push({ def: depDef, condition: edge.data });
        }
      }

      return result;
    };

    const dependentsOf = (name: string): ReadonlyArray<ServiceDef> => {
      const nodeIdx = getNodeIndex(name);
      if (nodeIdx === undefined) return [];

      // Direct dependents: follow outgoing edges from this node
      // Edges point FROM dependency TO dependent.
      const result: Array<ServiceDef> = [];
      for (const dependentIdx of Graph.successors(graph, nodeIdx)) {
        const dependent = serviceByNode.get(dependentIdx);
        if (dependent !== undefined) {
          result.push(dependent);
        }
      }

      return result;
    };

    return { startOrder, stopOrder, startOrderFor, dependenciesOf, dependentsOf };
  });
