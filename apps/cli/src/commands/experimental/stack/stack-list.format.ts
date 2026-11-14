import type { Effect } from "effect";
import { renderGlamourTable } from "../../../output/glamour-table.ts";
import type { StackApi } from "../../../command-internal/stack-target.ts";

type DiscoveredStack = Effect.Success<ReturnType<StackApi["Service"]["discover"]>>[number];

/** The `stack list` entries for discovered stacks, sorted by project root, name, then id. */
export const stackListEntries = (discovered: ReadonlyArray<DiscoveredStack>) =>
  discovered
    .map(({ definition, host }) => ({
      id: definition.id,
      project_root: definition.identity.projectRoot,
      name: definition.identity.stackName,
      branch_context: definition.identity.branchContext,
      runtime: definition.runtime,
      owner: host === undefined ? "unavailable" : "reachable",
    }))
    .sort((left, right) => {
      for (const field of ["project_root", "name", "id"] as const) {
        if (left[field] !== right[field]) return left[field] < right[field] ? -1 : 1;
      }
      return 0;
    });

/** The `stack list` text table; its ID column shows the first 8 characters. */
export const renderStackListTable = (stacks: ReturnType<typeof stackListEntries>) =>
  renderGlamourTable(
    ["NAME", "PROJECT", "BRANCH", "RUNTIME", "OWNER", "ID"],
    stacks.map((stack) => [
      stack.name,
      stack.project_root,
      stack.branch_context,
      stack.runtime,
      stack.owner,
      stack.id.slice(0, 8),
    ]),
  ).trimEnd();
