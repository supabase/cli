/**
 * Renders a `banned_ips = ["…", "…"]` TOML line, matching Go's encoding of
 * `struct { BannedIPs []string `toml:"banned_ips"` }` in
 * `apps/cli-go/internal/bans/get/get.go:24-29`.
 */
export function encodeBannedIpsToml(ips: ReadonlyArray<string>): string {
  return `banned_ips = [${ips.map((ip) => JSON.stringify(ip)).join(", ")}]\n`;
}
