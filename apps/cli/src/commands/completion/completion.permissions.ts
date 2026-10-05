import type { PermissionGroup } from "../../command-internal/command-permissions/model.ts";

/** Permission mapping for the `completion` command group. */
export const completionPermissions: PermissionGroup = {
  declared: new Map(),
  pending: ["completion bash", "completion fish", "completion powershell", "completion zsh"],
};
