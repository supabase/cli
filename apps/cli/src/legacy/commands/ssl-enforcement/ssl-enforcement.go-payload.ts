import {
  type LegacyGoType,
  legacyGoBool,
  legacyGoStruct,
} from "../../shared/legacy-go-struct-output.encoders.ts";

/**
 * Type shape for `api.SslEnforcementResponse` (`apps/cli-go/pkg/api/types.gen.go`).
 * Shared by `ssl-enforcement get` and `ssl-enforcement update` for
 * `-o yaml` / `-o toml` (CLI-1975).
 */
export const LEGACY_GO_SSL_ENFORCEMENT_RESPONSE: LegacyGoType = legacyGoStruct([
  ["appliedSuccessfully", legacyGoBool],
  ["currentConfig", legacyGoStruct([["database", legacyGoBool]])],
]);
