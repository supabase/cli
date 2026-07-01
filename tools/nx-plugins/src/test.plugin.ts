import type { CreateNodesV2, ProjectConfiguration } from "@nx/devkit";
import { createNodesFromFiles } from "@nx/devkit";
import { dirname, join } from "node:path";
import { existsSync } from "node:fs";

export interface TestPluginOptions {}

export const createNodesV2: CreateNodesV2<TestPluginOptions> = [
  "{apps,packages}/*/vitest.config.ts",
  async (vitestConfigFiles, _options, context) => {
    return await createNodesFromFiles(
      async (vitestConfigPath, _, context, idx) => {
        const projectRoot = dirname(vitestConfigPath);
        const project: ProjectConfiguration = {
          root: projectRoot,
        };
        const pkgJsonPath = join(projectRoot, "package.json");
        if (!existsSync(pkgJsonPath)) {
          // vitest.config file is not beside a package.json and therefore not a project
          return {
            projects: {
              [projectRoot]: {},
            },
          };
        }
        project.targets ??= {};

        const absoluteFilePath = join(context.workspaceRoot, vitestConfigPath);
        const { resolveConfig } = await loadVitestDynamicImport();
        const vitestConfig = await resolveConfig({
          config: absoluteFilePath,
          mode: "development",
        });

        const vitestProjects = vitestConfig.vitestConfig?.projects ?? [];
        if (vitestProjects.length > 0) {
          for (const vitestProject of vitestProjects) {
            if (typeof vitestProject !== "string" && vitestProject.test) {
              const testProject = vitestProject.test;
              const targetName = testProject.name;
              const extraInputs =
                projectRoot === "packages/stack" && targetName === "unit"
                  ? ["{workspaceRoot}/apps/cli-go/pkg/config/templates/Dockerfile"]
                  : [];
              project.targets = {
                ...project.targets,
                ...createTestTarget(
                  targetName,
                  [
                    ...(testProject.include ?? []),
                    ...(testProject.globalSetup ?? []),
                    ...(testProject.setupFiles ?? []),
                  ],
                  extraInputs,
                ),
              };
            }
          }
        } else {
          project.targets = { ...createTestTarget() };
        }
        return {
          projects: {
            [projectRoot]: project,
          },
        };
      },
      vitestConfigFiles,
      _options,
      context,
    );
  },
];

function createTestTarget(name: string = "", inputs: string[] = [], extraInputs: string[] = []) {
  return {
    [name !== "" ? `test:${name}` : "test"]: {
      command: `bun --bun vitest run${name !== "" ? ` --project ${name} --coverage.reportsDirectory=coverage/${name}` : ``}`,
      options: { cwd: "{projectRoot}" },
      cache: true,
      inputs: [
        "default",
        "sharedGlobals",
        ...inputs.map((input) => join(`{projectRoot}`, input)),
        ...extraInputs,
        { externalDependencies: ["vitest"] },
      ],
    },
  };
}

function loadVitestDynamicImport() {
  return Function('return import("vitest/node")')();
}
