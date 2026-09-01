import { defaultClientConditions, defaultServerConditions } from "vite";
import { defineConfig } from "vitest/config";

// This package publishes a `bun` export condition pointing at its
// TypeScript source (see package.json's `exports` map); without it, Vite's
// resolver falls through to the `default` condition and loads the built
// `dist/*.js` output instead — stale, or missing entirely on a fresh clone
// before the package has been built. Extending (not replacing) Vite's
// default condition lists keeps every other package's exports resolution
// unchanged. Required on every inline `test.projects` entry too: Vitest
// builds a separate Vite config per project and does not inherit these from
// the root config (see PR #6366 finding 0).
const workspacePackageResolve = { conditions: [...defaultClientConditions, "bun"] };
const workspacePackageSsrResolve = { conditions: [...defaultServerConditions, "bun"] };

export default defineConfig({
  resolve: workspacePackageResolve,
  ssr: { resolve: workspacePackageSsrResolve },
  test: {
    passWithNoTests: true,
    coverage: {
      enabled: false,
      provider: "istanbul",
      clean: false,
      include: ["src/**/*.ts"],
      reporter: ["text", "lcov"],
      reportsDirectory: "coverage",
    },
    projects: [
      {
        resolve: workspacePackageResolve,
        ssr: { resolve: workspacePackageSsrResolve },
        test: {
          name: "unit",
          include: ["**/*.unit.test.ts"],
        },
      },
    ],
  },
});
