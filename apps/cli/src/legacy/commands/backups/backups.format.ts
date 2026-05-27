const REGION_NAMES: Readonly<Record<string, string>> = {
  "ap-east-1": "East Asia (Hong Kong)",
  "ap-northeast-1": "Northeast Asia (Tokyo)",
  "ap-northeast-2": "Northeast Asia (Seoul)",
  "ap-south-1": "South Asia (Mumbai)",
  "ap-southeast-1": "Southeast Asia (Singapore)",
  "ap-southeast-2": "Oceania (Sydney)",
  "ca-central-1": "Canada (Central)",
  "eu-central-1": "Central EU (Frankfurt)",
  "eu-central-2": "Central Europe (Zurich)",
  "eu-north-1": "North EU (Stockholm)",
  "eu-west-1": "West EU (Ireland)",
  "eu-west-2": "West Europe (London)",
  "eu-west-3": "West EU (Paris)",
  "sa-east-1": "South America (São Paulo)",
  "us-east-1": "East US (North Virginia)",
  "us-east-2": "East US (Ohio)",
  "us-west-1": "West US (North California)",
  "us-west-2": "West US (Oregon)",
};

export function formatRegion(region: string): string {
  return REGION_NAMES[region] ?? region;
}

function pad2(value: number): string {
  return value.toString().padStart(2, "0");
}

/**
 * Reproduces `utils.FormatTimestamp` from `apps/cli-go/internal/utils/render.go:17`:
 * parse RFC3339; on success format as UTC "YYYY-MM-DD HH:MM:SS"; on failure
 * return the input verbatim.
 */
export function formatBackupTimestamp(value: string): string {
  if (value.length === 0) return value;
  // Go uses time.Parse(time.RFC3339, value). Date.parse accepts a broader format
  // surface, so we additionally require the year-month-day prefix to weed out
  // values like "2026-02-08 16:44:07" (already-formatted) that Date.parse would
  // happily accept but Go's strict RFC3339 parser would reject.
  if (!/^\d{4}-\d{2}-\d{2}T/.test(value)) {
    return value;
  }
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) return value;
  const date = new Date(parsed);
  return (
    `${date.getUTCFullYear()}-${pad2(date.getUTCMonth() + 1)}-${pad2(date.getUTCDate())} ` +
    `${pad2(date.getUTCHours())}:${pad2(date.getUTCMinutes())}:${pad2(date.getUTCSeconds())}`
  );
}
