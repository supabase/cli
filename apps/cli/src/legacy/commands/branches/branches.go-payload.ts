import {
  type LegacyGoType,
  legacyGoBool,
  legacyGoFloat32,
  legacyGoInt,
  legacyGoPtr,
  legacyGoSlice,
  legacyGoString,
  legacyGoStruct,
  legacyGoTime,
  legacyGoTomlListWrapper,
  legacyGoUuid,
} from "../../shared/legacy-go-struct-output.encoders.ts";

/**
 * Mirror of Go's `api.BranchResponse` (`apps/cli-go/pkg/api/types.gen.go`) —
 * field order and pointer-ness drive the `-o yaml` / `-o toml` byte shape
 * (CLI-1975). Shared by `branches list`, `branches create`, and
 * `branches update`, which all encode this struct.
 */
export const LEGACY_GO_BRANCH_RESPONSE: LegacyGoType = legacyGoStruct([
  ["created_at", legacyGoTime],
  ["deletion_scheduled_at", legacyGoPtr(legacyGoTime)],
  ["git_branch", legacyGoPtr(legacyGoString)],
  ["id", legacyGoUuid],
  ["is_default", legacyGoBool],
  ["latest_check_run_id", legacyGoPtr(legacyGoFloat32)],
  ["name", legacyGoString],
  ["notify_url", legacyGoPtr(legacyGoString)],
  ["parent_project_ref", legacyGoString],
  ["persistent", legacyGoBool],
  ["pr_number", legacyGoPtr(legacyGoInt)],
  ["preview_project_status", legacyGoPtr(legacyGoString)],
  ["project_ref", legacyGoString],
  ["review_requested_at", legacyGoPtr(legacyGoTime)],
  ["status", legacyGoString],
  ["updated_at", legacyGoTime],
  ["with_data", legacyGoBool],
]);

/** `branches list -o yaml` encodes the bare `[]api.BranchResponse`. */
export const LEGACY_GO_BRANCHES_LIST: LegacyGoType = legacyGoSlice(LEGACY_GO_BRANCH_RESPONSE);

/**
 * `branches list -o toml` wraps the slice:
 * `struct{ Branches []api.BranchResponse `toml:"branches"` }`.
 */
export const LEGACY_GO_BRANCHES_TOML_WRAPPER: LegacyGoType = legacyGoTomlListWrapper(
  "branches",
  LEGACY_GO_BRANCH_RESPONSE,
);
