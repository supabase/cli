import type { Scenario } from "./scenario.ts";

const argv = ["projects", "list", "--agent=no"];
const projects = [{ id: "abcdefghijklmnopqrst", name: "alpha", undeclared_field: "kept" }];
const routes = (body: unknown) => ({ "GET /v1/projects": { body, required: true } });

export const projectsList = {
  name: "projects-list",
  argv: [...argv, "--output-format", "<format>"],
  cases: (["json", "stream-json"] as const).flatMap((format) => [
    { name: `${format}/success`, format, exitCode: 0, routes: routes(projects) },
    { name: `${format}/invalid-response`, format, exitCode: 1, routes: routes({}) },
  ]),
} satisfies Scenario;

export const projectsListRaw = {
  name: "projects-list-raw",
  argv: [...argv, "--output", "<format>", "--output-format", "stream-json"],
  cases: [
    ...(["json", "yaml", "toml"] as const).map((format) => ({
      name: format,
      format,
      exitCode: 0,
      routes: routes(projects),
    })),
    { name: "toml/empty", format: "toml", exitCode: 0, routes: routes([]) },
  ],
} satisfies Scenario;
