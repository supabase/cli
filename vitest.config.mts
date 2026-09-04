import { defineConfig } from "vitest/config";
import { runDefaults } from "./vitest.shared.ts";

// Every package config becomes a nested project group named after the package,
// so `vitest --project 'supabase (unit)'` or `--project '*(integration)'` selects
// slices of the whole repo from one process. Root-only options such as `silent`
// are not inherited by these file-referenced projects; they come from
// `vitest.shared.ts` through each package config for standalone runs and are
// repeated here for root runs.
export default defineConfig({
  test: {
    ...runDefaults,
    projects: ["apps/*/vitest.config.ts", "packages/*/vitest.config.ts"],
  },
});
