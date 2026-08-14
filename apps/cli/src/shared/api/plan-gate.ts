export interface PlanGateEntitlement {
  readonly feature: string;
  readonly upgrade_url: string;
}

function readString(obj: unknown, key: string): string {
  if (typeof obj === "object" && obj !== null && key in obj) {
    const value = (obj as Record<string, unknown>)[key];
    return typeof value === "string" ? value : "";
  }
  return "";
}

const MAX_FIELD_LEN = 2048;

// Both fields print raw to the terminal and into machine-readable output, so a
// value with control characters or absurd length is malformed: no envelope.
function isCleanField(value: string): boolean {
  if (value.length === 0 || value.length > MAX_FIELD_LEN) return false;
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return false;
  }
  return true;
}

// Hand-validated: the packages/api codegen emits no non-2xx schemas.
export function parsePlanGateEnvelope(body: unknown): PlanGateEntitlement | undefined {
  if (typeof body !== "object" || body === null) return undefined;
  const error = (body as { readonly error?: unknown }).error;
  if (typeof error !== "object" || error === null) return undefined;
  const code = readString(error, "code");
  const feature = readString(error, "feature");
  const upgradeUrl = readString(error, "upgrade_url");
  if (code !== "entitlement_required" || !isCleanField(feature) || !isCleanField(upgradeUrl)) {
    return undefined;
  }
  return { feature, upgrade_url: upgradeUrl };
}

export function parsePlanGateEnvelopeText(raw: string): PlanGateEntitlement | undefined {
  try {
    return parsePlanGateEnvelope(JSON.parse(raw));
  } catch {
    return undefined;
  }
}

export function planGateSuggestion(renderedUpgradeUrl: string): string {
  return `Your organization does not have access to this feature. Upgrade your plan: ${renderedUpgradeUrl}`;
}

export function orgSlugFromUpgradeUrl(upgradeUrl: string): string {
  const match = /\/org\/([^/?#]+)/.exec(upgradeUrl);
  return match?.[1] ?? "";
}

export function errorEntitlement(error: unknown): PlanGateEntitlement | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const value = (error as { readonly entitlement?: unknown }).entitlement;
  if (typeof value !== "object" || value === null) return undefined;
  const feature = readString(value, "feature");
  const upgradeUrl = readString(value, "upgrade_url");
  if (!isCleanField(feature) || !isCleanField(upgradeUrl)) return undefined;
  return { feature, upgrade_url: upgradeUrl };
}
