import { describe, expect, it } from "vitest";
import { Command, Completions, type Param } from "effect/cli";

import { rootCommandForFeatures } from "../../cli/root.ts";
import { paramDocsOf, registeredParams } from "./cli-params.ts";

/**
 * Params the reference generator may meet without recorded docs, keyed `"<command path> <name>"`.
 * Every entry needs a reason.
 */
const ALLOWLIST: ReadonlyMap<string, string> = new Map([]);

const nameOf = (param: Param.Any): string =>
  Completions.fromCommand(Command.make("probe", { param })).flags[0]?.name ??
  Completions.fromCommand(Command.make("probe", { param })).arguments[0]?.name ??
  "<hidden>";

function undocumentedParams(
  command: Command.Command.Any,
  descriptor: Completions.CommandDescriptor,
  path: ReadonlyArray<string>,
  inheritedShared: ReadonlyArray<Param.AnyFlag>,
): ReadonlyArray<string> {
  const here = path.join(" ");
  const { own, shared, global } = registeredParams(command);
  const unrecorded = [...own, ...shared, ...global]
    .filter((param) => paramDocsOf(param) === undefined)
    .map((param) => `${here} ${nameOf(param)}`);

  const documented = (params: ReadonlyArray<Param.Any>, kind: Param.ParamKind) =>
    new Set(
      params.flatMap((param) => {
        const docs = paramDocsOf(param);
        return docs?.kind === kind ? [docs.name] : [];
      }),
    );
  const flagNames = documented([...own, ...shared, ...inheritedShared], "flag");
  const argumentNames = documented(own, "argument");
  const unregistered = [
    ...descriptor.flags.filter((flag) => !flagNames.has(flag.name)),
    ...descriptor.arguments.filter((argument) => !argumentNames.has(argument.name)),
  ].map((param) => `${here} ${param.name}`);

  const children = command.subcommands
    .flatMap((group) => group.commands)
    .flatMap((child) =>
      undocumentedParams(
        child,
        descriptor.subcommands.find((candidate) => candidate.name === child.name) ??
          Completions.fromCommand(child),
        [...path, child.name],
        [...inheritedShared, ...shared],
      ),
    );
  return [...unrecorded, ...unregistered, ...children];
}

describe("command tree params", () => {
  it("builds every flag and argument with docs metadata", () => {
    for (const stackBackend of ["legacy", "stack"] as const) {
      for (const computeEnabled of [false, true]) {
        const root = rootCommandForFeatures({ stackBackend, computeEnabled });
        const missing = undocumentedParams(root, Completions.fromCommand(root), ["supabase"], []);
        expect([...new Set(missing)].filter((key) => !ALLOWLIST.has(key))).toEqual([]);
      }
    }
  });
});
