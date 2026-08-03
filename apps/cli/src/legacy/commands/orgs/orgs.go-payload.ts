import {
  type LegacyGoType,
  legacyGoSlice,
  legacyGoString,
  legacyGoStruct,
  legacyGoTomlListWrapper,
} from "../../shared/legacy-go-struct-output.encoders.ts";

/**
 * Mirror of Go's `api.OrganizationResponseV1` (`apps/cli-go/pkg/api/types.gen.go`).
 * Shared by `orgs list` and `orgs create` for `-o yaml` / `-o toml` (CLI-1975).
 */
export const LEGACY_GO_ORGANIZATION_RESPONSE: LegacyGoType = legacyGoStruct([
  ["id", legacyGoString],
  ["name", legacyGoString],
  ["slug", legacyGoString],
]);

/** `orgs list -o yaml` encodes the bare `[]api.OrganizationResponseV1`. */
export const LEGACY_GO_ORGS_LIST: LegacyGoType = legacyGoSlice(LEGACY_GO_ORGANIZATION_RESPONSE);

/**
 * `orgs list -o toml` wraps the slice:
 * `struct{ Organizations []api.OrganizationResponseV1 `toml:"organizations"` }`.
 */
export const LEGACY_GO_ORGS_TOML_WRAPPER: LegacyGoType = legacyGoTomlListWrapper(
  "organizations",
  LEGACY_GO_ORGANIZATION_RESPONSE,
);
