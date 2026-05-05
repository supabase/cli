import type { CreateNodesV2 } from "@nx/devkit";
import { dirname } from "node:path";
import { readPkgJson } from "./parse-pkg-json";

export interface OxfmtPluginOptions {}

export const createNodesV2: CreateNodesV2<OxfmtPluginOptions> = [
  "{apps,packages}/*/package.json",
  (packageJsonFiles, _options, context) => {
    return packageJsonFiles.flatMap((packageJsonPath) => {
      const pkgJson = readPkgJson(context.workspaceRoot, packageJsonPath);

      // Only infer tasks when oxfmt is an explicit devDependency
      if (!pkgJson.devDependencies?.["oxfmt"]) return [];

      const projectRoot = dirname(packageJsonPath);

      return [
        [
          packageJsonPath,
          {
            projects: {
              [projectRoot]: {
                targets: {
                  "fmt:check": {
                    command: "oxfmt --check",
                    options: { cwd: "{projectRoot}" },
                    cache: true,
                    inputs: ["default", { externalDependencies: ["oxfmt"] }],
                  },
                  "fmt:fix": {
                    command: "oxfmt",
                    options: { cwd: "{projectRoot}" },
                    cache: false,
                  },
                },
                metadata: {
                  targetGroups: {
                    Checks: ["fmt:check", "fmt:fix"],
                  },
                },
              },
            },
          },
        ],
      ];
    });
  },
];
