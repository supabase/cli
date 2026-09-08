import {
  type GoType,
  goSlice,
  goString,
  goStruct,
  goTomlListWrapper,
} from "../../command-internal/go-struct-output.encoders.ts";

/**
 * Type shape for `api.OrganizationResponseV1` (`apps/cli-go/pkg/api/types.gen.go`).
 * Shared by `orgs list` and `orgs create` for `-o yaml` / `-o toml` (CLI-1975).
 */
export const GO_ORGANIZATION_RESPONSE: GoType = goStruct([
  ["id", goString],
  ["name", goString],
  ["slug", goString],
]);

/** `orgs list -o yaml` encodes the bare `[]api.OrganizationResponseV1`. */
export const GO_ORGS_LIST: GoType = goSlice(GO_ORGANIZATION_RESPONSE);

/**
 * `orgs list -o toml` wraps the slice:
 * `struct{ Organizations []api.OrganizationResponseV1 `toml:"organizations"` }`.
 */
export const GO_ORGS_TOML_WRAPPER: GoType = goTomlListWrapper(
  "organizations",
  GO_ORGANIZATION_RESPONSE,
);
