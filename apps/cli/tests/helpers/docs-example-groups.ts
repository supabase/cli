import type { DocsExampleKind } from "./docs-example-scenarios.ts";

/** Picks recorded docs examples: by the first segment of the command path or by scenario name. */
export interface DocsExampleSelector {
  readonly commands?: ReadonlyArray<string>;
  readonly scenarios?: ReadonlyArray<string>;
}

/**
 * The recorded docs examples each `src/docs/docs-examples/*.e2e.test.ts` file runs. Every
 * recorded example must be picked by exactly one group (checked in `docs-examples.unit.test.ts`),
 * so a new command or scenario fails there until it joins a group.
 *
 * Docker groups split by stack state: each file starts its own stack, so the startup cost is paid
 * once per group. `lifecycle` starts and stops the stack, `running` runs read-mostly commands against a running
 * one, and `schema` runs the diff, pull and declarative sync examples that change the database.
 */
export const DOCS_EXAMPLE_GROUPS = {
  replay: {
    projects: { commands: ["projects", "link"] },
    sso: { commands: ["sso"] },
  },
  local: {
    init: { commands: ["init"] },
    migration: { commands: ["migration"] },
  },
  docker: {
    lifecycle: { scenarios: ["docker-stack-stopped", "docker-stack-stopping"] },
    running: { scenarios: ["docker-stack-running", "docker-self-hosted"] },
    schema: {
      scenarios: ["docker-schema-drift", "docker-declarative-missing", "docker-declarative-edited"],
    },
  },
} as const satisfies Record<DocsExampleKind, Record<string, DocsExampleSelector>>;

export type DocsExampleGroups = {
  [Kind in keyof typeof DOCS_EXAMPLE_GROUPS]: keyof (typeof DOCS_EXAMPLE_GROUPS)[Kind];
};

/** Whether `group` picks the example at `commandPath` that runs `scenario`. */
export const groupSelects = (
  group: DocsExampleSelector,
  example: { readonly commandPath: ReadonlyArray<string>; readonly scenario?: string | undefined },
): boolean =>
  (group.commands?.includes(example.commandPath[0] ?? "") ?? false) ||
  (group.scenarios?.includes(example.scenario ?? "") ?? false);
