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
