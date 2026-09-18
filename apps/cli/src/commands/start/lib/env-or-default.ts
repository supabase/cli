/** Project values win, including empty strings; defaults apply only to absent values. */
export function envOrDefault(
  key: string,
  def: string,
  projectEnvValues: Readonly<Record<string, string>> | undefined,
  ambientEnvValues: Readonly<Record<string, string>> = {},
): string {
  return projectEnvValues?.[key] ?? ambientEnvValues[key] ?? def;
}
