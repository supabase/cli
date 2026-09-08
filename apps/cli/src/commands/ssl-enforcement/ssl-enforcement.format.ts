// Structural shape matches both `V1GetSslEnforcementConfigOutput.Type` and
// `V1UpdateSslEnforcementConfigOutput.Type` — `update.Run` delegates to
// `get.PrintSSLStatus` after a successful PUT, and the two
// response schemas are byte-identical. Keeping the parameter type local
// decouples this formatter from the generated API types and survives any
// future divergence between the two schemas.
interface SslEnforcementStatus {
  readonly currentConfig: { readonly database: boolean };
  readonly appliedSuccessfully: boolean;
}

/**
 * Reproduces `PrintSSLStatus`.
 */
export function printSslStatus(response: SslEnforcementStatus): string {
  if (response.currentConfig.database && response.appliedSuccessfully) {
    return "SSL is being enforced.\n";
  }
  return "SSL is *NOT* being enforced.\n";
}
