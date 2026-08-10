export interface RestartClosureGraph {
  readonly order: ReadonlyArray<string>;
  readonly dependentsOf: (name: string) => ReadonlyArray<string>;
}

/**
 * Returns the requested service and every connector on a path to an active dependent.
 * The result preserves dependency start order so callers can stop it in reverse safely.
 */
export const restartClosureFor = (
  graph: RestartClosureGraph,
  name: string,
  activeServices: ReadonlySet<string>,
): ReadonlyArray<string> => {
  const closure = new Set<string>([name]);
  const visited = new Set<string>();

  const collectDependents = (current: string): boolean => {
    if (visited.has(current)) {
      return closure.has(current);
    }
    visited.add(current);

    let connectsToActiveDependent = false;
    for (const dependent of graph.dependentsOf(current)) {
      const descendantConnectsToActive = collectDependents(dependent);
      if (activeServices.has(dependent) || descendantConnectsToActive) {
        closure.add(dependent);
        connectsToActiveDependent = true;
      }
    }
    return connectsToActiveDependent;
  };

  collectDependents(name);
  return graph.order.filter((service) => closure.has(service));
};
