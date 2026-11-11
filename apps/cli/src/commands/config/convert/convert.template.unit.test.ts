import { convertCliConfigTomlToJsonc, parseJsonc } from "@supabase/config/internal";
import { Effect } from "effect";
import { parse as parseToml } from "smol-toml";
import { describe, expect, it } from "vitest";

import { renderCliConfigTemplate } from "../../../shared/init/project-init.templates.ts";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function leaves(value: unknown, path: ReadonlyArray<string> = []): Map<string, unknown> {
  if (!isRecord(value) || Object.keys(value).length === 0) {
    return new Map([[path.join("."), value]]);
  }
  return new Map(
    Object.entries(value).flatMap(([key, child]) => [...leaves(child, [...path, key])]),
  );
}

function added(after: Map<string, unknown>, before: Map<string, unknown>) {
  return new Map([...after].filter(([path]) => !before.has(path)));
}

function commentedMembers(lines: ReadonlyArray<string>): Array<readonly [number, number]> {
  const members: Array<readonly [number, number]> = [];
  for (let start = 0; start < lines.length; start++) {
    const match = /^(\s*)\/\/ "[^"]+": (.*)$/.exec(lines[start] ?? "");
    if (match === null) {
      continue;
    }
    let end = start;
    if (/[{[]$/.test(match[2] ?? "")) {
      const close = new RegExp(`^${match[1]}// [}\\]],$`);
      while (end < lines.length && !close.test(lines[end] ?? "")) {
        end++;
      }
      if (end === lines.length) {
        throw new Error(`No closing delimiter for the commented member on line ${start + 1}`);
      }
    }
    members.push([start, end]);
    start = end;
  }
  return members;
}

describe("converted init template", () => {
  const template = renderCliConfigTemplate("demo", false);
  const jsonc = Effect.runSync(convertCliConfigTomlToJsonc(template)).text;
  const lines = jsonc.split("\n");
  const example = /^# (\[[^\]]+\]|[\w."'-]+ = .+)$/;

  it("uncommenting any one example yields valid JSONC with its value where the TOML example implied", () => {
    const withExamples = template
      .split("\n")
      .map((line) => (example.test(line) ? line.slice(2) : line))
      .join("\n");
    const active = leaves(parseJsonc(jsonc));
    const expected = added(leaves(parseToml(withExamples)), leaves(parseToml(template)));
    const members = commentedMembers(lines);
    const seen = new Map<string, unknown>();

    for (const [start, end] of members) {
      const document = lines
        .map((line, index) =>
          index >= start && index <= end ? line.replace(/^(\s*)\/\/ ?/, "$1") : line,
        )
        .join("\n");
      const gained = added(leaves(parseJsonc(document)), active);
      expect(gained.size).toBeGreaterThan(0);
      for (const [path, value] of gained) {
        seen.set(path, value);
      }
    }

    expect(members.length).toBeGreaterThan(30);
    expect(seen.get("auth.hook.custom_access_token.enabled")).toBe(true);
    expect(seen).toEqual(expected);
  });
});
