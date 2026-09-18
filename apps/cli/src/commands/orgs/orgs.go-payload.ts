import {
  type GoType,
  goSlice,
  goString,
  goStruct,
  goTomlListWrapper,
} from "../../command-internal/go-struct-output.encoders.ts";

/** Struct shape for `-o yaml`/`-o toml` key casing, shared by `orgs list` and `orgs create`. */
export const GO_ORGANIZATION_RESPONSE: GoType = goStruct([
  ["id", goString],
  ["name", goString],
  ["slug", goString],
]);

/** `orgs list -o yaml` encodes the bare organization list. */
export const GO_ORGS_LIST: GoType = goSlice(GO_ORGANIZATION_RESPONSE);

/** `orgs list -o toml` wraps the list under an `organizations` key. */
export const GO_ORGS_TOML_WRAPPER: GoType = goTomlListWrapper(
  "organizations",
  GO_ORGANIZATION_RESPONSE,
);
