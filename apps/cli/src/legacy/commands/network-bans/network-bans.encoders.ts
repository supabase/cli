/**
 * Renders a `banned_ips = ["…", "…"]` TOML line, matching Go's encoding of
 * `struct { BannedIPs []string `toml:"banned_ips"` }` in
 * `apps/cli-go/internal/bans/get/get.go:24-29` (deleted in CLI-1970; last
 * present at commit 7b469f5b3).
 */
export function encodeBannedIpsToml(ips: ReadonlyArray<string>): string {
  return `banned_ips = [${ips.map((ip) => JSON.stringify(ip)).join(", ")}]\n`;
}
