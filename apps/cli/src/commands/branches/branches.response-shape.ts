import {
  type OutputShape,
  shapeBool,
  shapeFloat32,
  shapeInt,
  shapePtr,
  shapeSlice,
  shapeString,
  shapeStruct,
  shapeTime,
  shapeTomlListWrapper,
  shapeUuid,
} from "../../command-internal/struct-output.encoders.ts";

/**
 * Struct spec whose field order and pointer-ness drive the `-o yaml` / `-o toml`
 * byte shape. Shared by `branches list`, `branches create`, and
 * `branches update`, which all encode this struct.
 */
export const BRANCH_RESPONSE_SHAPE: OutputShape = shapeStruct([
  ["created_at", shapeTime],
  ["deletion_scheduled_at", shapePtr(shapeTime)],
  ["git_branch", shapePtr(shapeString)],
  ["id", shapeUuid],
  ["is_default", shapeBool],
  ["latest_check_run_id", shapePtr(shapeFloat32)],
  ["name", shapeString],
  ["notify_url", shapePtr(shapeString)],
  ["parent_project_ref", shapeString],
  ["persistent", shapeBool],
  ["pr_number", shapePtr(shapeInt)],
  ["preview_project_status", shapePtr(shapeString)],
  ["project_ref", shapeString],
  ["review_requested_at", shapePtr(shapeTime)],
  ["status", shapeString],
  ["updated_at", shapeTime],
  ["with_data", shapeBool],
]);

/** `branches list -o yaml` encodes the bare array of branch structs. */
export const BRANCHES_LIST_SHAPE: OutputShape = shapeSlice(BRANCH_RESPONSE_SHAPE);

/** `branches list -o toml` wraps the array under a top-level `branches` key. */
export const BRANCHES_TOML_WRAPPER_SHAPE: OutputShape = shapeTomlListWrapper(
  "branches",
  BRANCH_RESPONSE_SHAPE,
);
