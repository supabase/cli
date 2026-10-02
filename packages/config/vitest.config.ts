import { defaultClientConditions, defaultServerConditions } from "vite";
import { defineConfig } from "vitest/config";

// Adds the `bun` export condition so Vite resolves this package's TypeScript source
// instead of a possibly stale or missing `dist/*.js` build. Must be repeated on every
// inline `test.projects` entry; Vitest builds a separate Vite config per project.
const workspacePackageResolve = { conditions: [...defaultClientConditions, "bun"] };
const workspacePackageSsrResolve = { conditions: [...defaultServerConditions, "bun"] };

export default defineConfig({
  resolve: workspacePackageResolve,
  ssr: { resolve: workspacePackageSsrResolve },
  test: {
    passWithNoTests: true,
    coverage: {
      enabled: false,
      provider: "v8",
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
