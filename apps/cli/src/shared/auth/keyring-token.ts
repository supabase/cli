const GO_KEYRING_BASE64_PREFIX = "go-keyring-base64:";

export function normalizeKeyringToken(value: string): string {
  if (!value.startsWith(GO_KEYRING_BASE64_PREFIX)) {
    return value;
  }

  return Buffer.from(value.slice(GO_KEYRING_BASE64_PREFIX.length), "base64").toString("utf8");
}
