const KEYRING_BASE64_PREFIX = "go-keyring-base64:";

export function normalizeKeyringToken(value: string): string {
  if (!value.startsWith(KEYRING_BASE64_PREFIX)) {
    return value;
  }

  return Buffer.from(value.slice(KEYRING_BASE64_PREFIX.length), "base64").toString("utf8");
}
