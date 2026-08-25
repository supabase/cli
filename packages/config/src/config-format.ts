/**
 * Leaf module with zero imports of its own. `errors.ts` — this package's
 * most primitive module — needs `ConfigFormat` for {@link CliConfigParseError},
 * so this type lives here rather than in `config-document.ts`, which itself
 * imports from `project.ts`, which imports from `errors.ts`. Defining
 * `ConfigFormat` in `config-document.ts` would create an
 * `errors.ts` → `config-document.ts` → `project.ts` → `errors.ts` import
 * cycle (benign at runtime today, but a live constraint for declaration
 * emit).
 */
export type ConfigFormat = "json" | "toml";
