import { describe, expect, it } from "@effect/vitest";

import { rootCommandForFeatures } from "../cli/root.ts";
import { walkCommandTree } from "../../tests/helpers/command-tree.ts";
import { CLI_CONFIG_FLAGS } from "./cli-config-key-annotations.ts";
import { unwrapParam } from "../command-internal/param-introspection.ts";
import { cliConfigFlagBinding } from "./cli-config-flags.ts";
import { cliConfigRegistry } from "./cli-config-keys.ts";

const declarations: ReadonlyArray<{ path: string; names: ReadonlyArray<string> }> = Object.entries(
  CLI_CONFIG_FLAGS,
).map(([path, declaration]) => ({ path, names: declaration.names }));

const ownerOf = new Map(declarations.flatMap(({ path, names }) => names.map((n) => [n, path])));

const commands = walkCommandTree(
  rootCommandForFeatures({ stackBackend: "stack", computeEnabled: true }),
);

const ownedFlags = commands.flatMap((entry) =>
  entry.flags
    .filter((flag) => ownerOf.has(flag.name))
    .map((flag) => ({ ...flag, command: entry.path.join(" "), entry })),
);

describe("config flag ownership", () => {
  it("declares every owned flag against a real registry key", () => {
    const unknown = declarations.filter(({ path }) => cliConfigRegistry.keyAt(path) === undefined);

    expect(unknown).toEqual([]);
  });

  it("finds every declared flag name somewhere in the command tree", () => {
    const found = new Set(ownedFlags.map((flag) => flag.name));
    const missing = [...ownerOf.keys()].filter((name) => !found.has(name));

    expect(missing).toEqual([]);
  });

  it("reaches hidden owned flags, so the binding check covers them", () => {
    const hidden = ownedFlags.filter((flag) => unwrapParam(flag.param)?.single.hidden === true);

    expect(hidden.length).toBeGreaterThan(0);
  });

  it("binds every command flag the registry owns to its declared key, hidden ones included", () => {
    const unbound = ownedFlags.flatMap((flag) => {
      const binding = flag.entry.bindings.find((candidate) => candidate.flag === flag.name);
      return binding?.path === ownerOf.get(flag.name) &&
        cliConfigFlagBinding(flag.param)?.path === ownerOf.get(flag.name)
        ? []
        : [`${flag.command} --${flag.name}`];
    });

    expect(unbound).toEqual([]);
  });

  it("annotates no command with a binding the registry does not declare", () => {
    const stray = commands.flatMap((entry) =>
      entry.bindings
        .filter((binding) => ownerOf.get(binding.flag) !== binding.path)
        .map((binding) => `${entry.path.join(" ")} --${binding.flag} -> ${binding.path}`),
    );

    expect(stray).toEqual([]);
  });
});
