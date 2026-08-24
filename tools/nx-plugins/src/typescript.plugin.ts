import type { CreateNodesV2 } from "@nx/devkit";
import { dirname } from "node:path";
import { readPkgJson } from "./parse-pkg-json.ts";

export interface TypeScriptPluginOptions {}

export const createNodesV2: CreateNodesV2<TypeScriptPluginOptions> = [
  "{apps,packages}/*/package.json",
  (packageJsonFiles, _options, context) => {
    return packageJsonFiles.flatMap((packageJsonPath) => {
      const pkgJson = readPkgJson(context.workspaceRoot, packageJsonPath);

      if (!pkgJson.devDependencies?.typescript) return [];

      const projectRoot = dirname(packageJsonPath);

      return [
        [
          packageJsonPath,
          {
            projects: {
              [projectRoot]: {
                targets: {
                  "types:check": {
                    command: "tsc --noEmit",
                    options: { cwd: "{projectRoot}" },
                    cache: true,
                    inputs: ["default", { externalDependencies: ["typescript"] }],
                  },
                },
                metadata: {
                  targetGroups: {
                    Checks: ["types:check"],
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
