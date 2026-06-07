import type { CreateNodesV2 } from "@nx/devkit";
import { dirname } from "node:path";
import { readPkgJson } from "./parse-pkg-json";

export interface KnipPluginOptions {}

export const createNodesV2: CreateNodesV2<KnipPluginOptions> = [
  "{apps,packages}/*/package.json",
  (packageJsonFiles, _options, context) => {
    return packageJsonFiles.flatMap((packageJsonPath) => {
      const pkgJson = readPkgJson(context.workspaceRoot, packageJsonPath);

      // Only infer tasks when an explicit knip config object is present
      if (!pkgJson.knip || typeof pkgJson.knip !== "object") return [];

      const projectRoot = dirname(packageJsonPath);

      // Use knip.entry for fine-grained inputs; fall back to named "default"
      const entry: string[] = pkgJson.knip.entry ?? [];
      const inputs =
        entry.length > 0
          ? [
              ...entry.map((e) => `{projectRoot}/${e}`),
              "sharedGlobals",
              { externalDependencies: ["knip"] },
            ]
          : ["default", "sharedGlobals", { externalDependencies: ["knip"] }];

      return [
        [
          packageJsonPath,
          {
            projects: {
              [projectRoot]: {
                targets: {
                  "knip:check": {
                    command: "knip-bun",
                    options: { cwd: "{projectRoot}" },
                    cache: true,
                    inputs,
                  },
                  "knip:fix": {
                    command: "knip-bun --fix",
                    options: { cwd: "{projectRoot}" },
                    cache: false,
                  },
                },
                metadata: {
                  targetGroups: {
                    Checks: ["knip:check", "knip:fix"],
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
