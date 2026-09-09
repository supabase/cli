import {
  type GoType,
  goBool,
  goFloat32,
  goInt,
  goPtr,
  goSlice,
  goString,
  goStruct,
  goTime,
  goTomlListWrapper,
  goUuid,
} from "../../command-internal/go-struct-output.encoders.ts";

/**
 * Struct spec whose field order and pointer-ness drive the `-o yaml` / `-o toml`
 * byte shape. Shared by `branches list`, `branches create`, and
 * `branches update`, which all encode this struct.
 */
export const GO_BRANCH_RESPONSE: GoType = goStruct([
  ["created_at", goTime],
  ["deletion_scheduled_at", goPtr(goTime)],
  ["git_branch", goPtr(goString)],
  ["id", goUuid],
  ["is_default", goBool],
  ["latest_check_run_id", goPtr(goFloat32)],
  ["name", goString],
  ["notify_url", goPtr(goString)],
  ["parent_project_ref", goString],
  ["persistent", goBool],
  ["pr_number", goPtr(goInt)],
  ["preview_project_status", goPtr(goString)],
  ["project_ref", goString],
  ["review_requested_at", goPtr(goTime)],
  ["status", goString],
  ["updated_at", goTime],
  ["with_data", goBool],
]);

/** `branches list -o yaml` encodes the bare `[]api.BranchResponse`. */
export const GO_BRANCHES_LIST: GoType = goSlice(GO_BRANCH_RESPONSE);

/**
 * `branches list -o toml` wraps the slice:
 * `struct{ Branches []api.BranchResponse `toml:"branches"` }`.
 */
export const GO_BRANCHES_TOML_WRAPPER: GoType = goTomlListWrapper("branches", GO_BRANCH_RESPONSE);
