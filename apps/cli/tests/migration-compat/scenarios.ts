import { branchesDelete } from "./branches-delete.scenario.ts";
import { projectsList, projectsListRaw } from "./projects-list.scenario.ts";
import type { Scenario } from "./scenario.ts";

export const scenarios: readonly Scenario[] = [branchesDelete, projectsList, projectsListRaw];
