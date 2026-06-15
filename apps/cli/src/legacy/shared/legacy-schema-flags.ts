/**
 * Normalizes a repeated `--schema` flag into the flat list Go produces.
 *
 * Go defines `--schema` as a Cobra `StringSliceVarP` on both `gen types`
 * (`apps/cli-go/cmd/gen.go:155`) and `db lint` (`apps/cli-go/cmd/db.go:506`),
 * and Cobra's `StringSlice` splits each value on commas. So the documented
 * `--schema public,private` form must become `["public", "private"]`, exactly
 * like the repeated `--schema public --schema private` form. The Effect CLI
 * `Flag.atLeast(0)` only accumulates repeated occurrences, so this second half
 * of the parity — splitting comma-separated entries, trimming, and dropping
 * empties — is applied here before the value is used.
 *
 * Shared by `gen types` and `db lint` (two command families), so it lives in
 * `legacy/shared/` per the hoist-before-you-duplicate rule.
 */
export function legacyNormalizeSchemaFlags(raw: ReadonlyArray<string>): ReadonlyArray<string> {
  const schemas: string[] = [];
  for (const value of raw) {
    for (const schema of value.split(",")) {
      const trimmed = schema.trim();
      if (trimmed.length > 0) {
        schemas.push(trimmed);
      }
    }
  }
  return schemas;
}
