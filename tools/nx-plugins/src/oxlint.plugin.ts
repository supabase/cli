import type { CreateNodesV2 } from "@nx/devkit";
import { dirname } from "node:path";
import { readPkgJson } from "./parse-pkg-json";

export interface OxlintPluginOptions {}

export const createNodesV2: CreateNodesV2<OxlintPluginOptions> = [
  "{apps,packages}/*/package.json",
  (packageJsonFiles, _options, context) => {
    return packageJsonFiles.flatMap((packageJsonPath) => {
      const pkgJson = readPkgJson(context.workspaceRoot, packageJsonPath);

      if (!pkgJson.devDependencies?.["oxlint"]) return [];

      const projectRoot = dirname(packageJsonPath);
      const typeAware = (pkgJson.oxlint as { typeAware?: boolean } | undefined)?.typeAware ?? false;
      const typeAwareFlag = typeAware ? "--type-aware " : "";

      return [
        [
          packageJsonPath,
          {
            projects: {
              [projectRoot]: {
                targets: {
                  "lint:check": {
                    command: `oxlint ${typeAwareFlag}--deny-warnings`,
                    options: { cwd: "{projectRoot}" },
                    cache: true,
                    inputs: ["default", { externalDependencies: ["oxlint"] }],
                  },
                  "lint:fix": {
                    command: `oxlint ${typeAwareFlag}--deny-warnings --fix`,
                    options: { cwd: "{projectRoot}" },
                    cache: false,
                  },
                },
                metadata: {
                  targetGroups: {
                    Checks: ["lint:check", "lint:fix"],
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
