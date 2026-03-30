import type { CreateNodesV2 } from "@nx/devkit";
import { dirname } from "node:path";
import { readPkgJson } from "./parse-pkg-json";

export interface TsgoPluginOptions {}

export const createNodesV2: CreateNodesV2<TsgoPluginOptions> = [
  "{apps,packages}/*/package.json",
  (packageJsonFiles, _options, context) => {
    return packageJsonFiles.flatMap((packageJsonPath) => {
      const pkgJson = readPkgJson(context.workspaceRoot, packageJsonPath);

      if (!pkgJson.devDependencies?.["@typescript/native-preview"]) return [];

      const projectRoot = dirname(packageJsonPath);

      return [
        [
          packageJsonPath,
          {
            projects: {
              [projectRoot]: {
                targets: {
                  "types:check": {
                    command: "tsgo --noEmit",
                    options: { cwd: "{projectRoot}" },
                    cache: true,
                    inputs: ["default", { externalDependencies: ["@typescript/native-preview"] }],
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
