import { block } from "../../command-internal/command-permissions/model.ts";

/** `--remote=<ref>` names the parent outright; otherwise a cached parent is checked against its own branches. */
export const branchesParentTarget = block("branches-parent-target", [
  {
    operationId: "v1-list-all-branches",
    kind: "best-effort",
    when: [{ selector: ["none", "bare"] }],
    context:
      "a cached parent differs from the linked project, so its branches are listed to check it",
  },
]);
