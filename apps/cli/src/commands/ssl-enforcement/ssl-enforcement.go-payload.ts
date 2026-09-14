import { type GoType, goBool, goStruct } from "../../command-internal/go-struct-output.encoders.ts";

/**
 * Type shape for the SSL enforcement response, used to drive `-o yaml`/`-o
 * toml` key casing. Shared by `ssl-enforcement get` and `ssl-enforcement
 * update`.
 */
export const GO_SSL_ENFORCEMENT_RESPONSE: GoType = goStruct([
  ["appliedSuccessfully", goBool],
  ["currentConfig", goStruct([["database", goBool]])],
]);
