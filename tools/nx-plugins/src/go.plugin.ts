import type { CreateNodesV2 } from "@nx/devkit";
import { dirname } from "node:path";

export interface GoPluginOptions {
  projectName?: string;
  binaryName?: string;
}

export const createNodesV2: CreateNodesV2<GoPluginOptions> = [
  "apps/*/go.mod",
  (goModFiles, options, _context) => {
    const projectName = options?.projectName ?? "cli-go";
    const binaryName = options?.binaryName ?? "supabase-go";

    return goModFiles.map((goModPath) => {
      const projectRoot = dirname(goModPath);

      return [
        goModPath,
        {
          projects: {
            [projectRoot]: {
              name: projectName,
              targets: {
                build: {
                  command: `go build -o ${binaryName} .`,
                  options: { cwd: "{projectRoot}", forwardAllArgs: false },
                  cache: true,
                  inputs: ["default", { runtime: "go version" }],
                  outputs: [`{projectRoot}/${binaryName}`],
                },
                "test:unit": {
                  command: "go test ./...",
                  options: { cwd: "{projectRoot}", forwardAllArgs: false },
                  cache: true,
                  inputs: ["default", { runtime: "go version" }],
                },
                "lint:check": {
                  command: "golangci-lint run --timeout 5m",
                  options: { cwd: "{projectRoot}", forwardAllArgs: false },
                  cache: true,
                  inputs: ["default", { runtime: "go version" }],
                },
                "lint:fix": {
                  command: "golangci-lint run --fix",
                  options: { cwd: "{projectRoot}", forwardAllArgs: false },
                  cache: false,
                },
              },
              metadata: {
                targetGroups: {
                  Build: ["build"],
                  Tests: ["test:unit"],
                  Checks: ["lint:check", "lint:fix"],
                },
              },
            },
          },
        },
      ];
    });
  },
];
