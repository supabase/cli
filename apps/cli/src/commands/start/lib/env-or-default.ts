/** Project values win, including empty strings; defaults apply only to absent values. */
export function envOrDefault(
  key: string,
  def: string,
  projectEnvValues: Readonly<Record<string, string>> | undefined,
): string {
  return projectEnvValues?.[key] ?? def;
}
