import { type GoType, goBool, goStruct } from "../../command-internal/go-struct-output.encoders.ts";

/**
 * Type shape for `api.SslEnforcementResponse` (`apps/cli-go/pkg/api/types.gen.go`).
 * Shared by `ssl-enforcement get` and `ssl-enforcement update` for
 * `-o yaml` / `-o toml` (CLI-1975).
 */
export const GO_SSL_ENFORCEMENT_RESPONSE: GoType = goStruct([
  ["appliedSuccessfully", goBool],
  ["currentConfig", goStruct([["database", goBool]])],
]);
