/**
 * Renders a `banned_ips = ["…", "…"]` TOML line, matching the encoding of
 * `struct { BannedIPs []string `toml:"banned_ips"` }`.
 */
export function encodeBannedIpsToml(ips: ReadonlyArray<string>): string {
  return `banned_ips = [${ips.map((ip) => JSON.stringify(ip)).join(", ")}]\n`;
}
