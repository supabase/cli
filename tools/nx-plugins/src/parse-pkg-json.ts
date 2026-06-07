import { readFileSync } from "node:fs";
import { join } from "node:path";

// package.json files in this repo use trailing commas (JSON5 style).
// Strip them before parsing so that Node's strict JSON.parse doesn't fail.
function parseJson(text: string) {
  return JSON.parse(text.replace(/,(\s*[}\]])/g, "$1"));
}

export function readPkgJson(workspaceRoot: string, packageJsonPath: string): Record<string, any> {
  const text = readFileSync(join(workspaceRoot, packageJsonPath), "utf-8");
  return parseJson(text);
}
