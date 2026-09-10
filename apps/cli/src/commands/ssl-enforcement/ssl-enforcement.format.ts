// Matches the structural shape of both get and update SSL-enforcement
// response types (byte-identical schemas). Kept local, rather than importing
// the generated type, to decouple this formatter from future API divergence.
interface SslEnforcementStatus {
  readonly currentConfig: { readonly database: boolean };
  readonly appliedSuccessfully: boolean;
}

export function printSslStatus(response: SslEnforcementStatus): string {
  if (response.currentConfig.database && response.appliedSuccessfully) {
    return "SSL is being enforced.\n";
  }
  return "SSL is *NOT* being enforced.\n";
}
