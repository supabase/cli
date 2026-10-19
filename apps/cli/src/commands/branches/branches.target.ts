import { block } from "../../command-internal/command-permissions/model.ts";

/** `--remote` only picks the parent project; it never changes which operations a branches command calls. */
export const branchesParentTarget = block("branches-parent-target", [], ["remote"]);
