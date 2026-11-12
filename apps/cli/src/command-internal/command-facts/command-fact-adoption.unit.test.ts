import { describe, expect, it } from "@effect/vitest";
import { Context, Effect } from "effect";
import { Command } from "effect/cli";

import { rootCommand } from "../../cli/root.ts";
import { flattenSubcommands } from "../../docs/docs-introspection.ts";
import { hasOptionalSubcommand } from "../../shared/output/optional-subcommand-usage.ts";
import { CommandPermissionsAnnotation } from "../command-permissions/command-permissions.annotation.ts";
import { TargetPolicyAnnotation } from "../target/target-policy.ts";
import { CommandOutputAnnotation } from "./command-output.ts";
import { OUTPUT_EXCEPTIONS } from "./command-output.exceptions.ts";

const REQUIRED_FACTS = [
  CommandOutputAnnotation.key,
  TargetPolicyAnnotation.key,
  CommandPermissionsAnnotation.key,
] as const;

type Exceptions = Readonly<Record<string, ReadonlyMap<string, string>>>;

const executableCommands = (root: Command.Command.Any) => {
  const found: Array<{ readonly path: string; readonly command: Command.Command.Any }> = [];
  const visit = (command: Command.Command.Any, path: ReadonlyArray<string>) => {
    const children = flattenSubcommands(command);
    if (path.length > 0 && (children.length === 0 || hasOptionalSubcommand(command))) {
      found.push({ path: path.join(" "), command });
    }
    children.forEach((child) => visit(child, [...path, child.name]));
  };
  visit(root, []);
  return found;
};

/** Missing facts without an exception, and exceptions for facts the command now declares. */
const adoptionGaps = (root: Command.Command.Any, exceptions: Exceptions) => {
  const missing: Array<string> = [];
  const stale: Array<string> = [];
  const executable = executableCommands(root);
  for (const { path, command } of executable) {
    for (const fact of REQUIRED_FACTS) {
      const present = command.annotations.mapUnsafe.has(fact);
      const excepted = exceptions[fact]?.has(path) ?? false;
      if (!present && !excepted) missing.push(`${path}: ${fact}`);
      if (present && excepted) stale.push(`${path}: ${fact}`);
    }
  }
  const paths = new Set(executable.map((entry) => entry.path));
  for (const [fact, entries] of Object.entries(exceptions)) {
    for (const path of entries.keys()) {
      if (!paths.has(path)) stale.push(`${path}: ${fact}`);
    }
  }
  return { missing, stale };
};

const PROJECT_EXCEPTIONS: Exceptions = { [CommandOutputAnnotation.key]: OUTPUT_EXCEPTIONS };

const withFacts = (
  command: Command.Command.Any,
  facts: ReadonlyArray<(typeof REQUIRED_FACTS)[number]>,
): Command.Command.Any =>
  facts.reduce(
    (current, fact) => Command.annotate(Context.Service<never, unknown>()(fact), true)(current),
    command,
  );

const fixture = (facts: ReadonlyArray<(typeof REQUIRED_FACTS)[number]>) =>
  Command.make("supabase").pipe(
    Command.withSubcommands([
      withFacts(
        Command.make("leaf", {}, () => Effect.void),
        facts,
      ),
    ]),
  );

describe("command fact adoption", () => {
  it("requires output, target policy and permissions on every executable command", () => {
    expect(adoptionGaps(rootCommand, PROJECT_EXCEPTIONS)).toEqual({ missing: [], stale: [] });
  });

  it("only excepts streaming commands for a reason other than pending adoption", () => {
    const streaming = [...OUTPUT_EXCEPTIONS].filter(([, reason]) => reason === "streaming");
    expect(streaming.map(([path]) => path).toSorted()).toEqual(["functions serve", "logs"]);
  });

  it("does not except branches delete", () => {
    expect(OUTPUT_EXCEPTIONS.has("branches delete")).toBe(false);
  });

  it.each(REQUIRED_FACTS)("fails a command that drops %s", (dropped) => {
    const root = fixture(REQUIRED_FACTS.filter((fact) => fact !== dropped));
    expect(adoptionGaps(root, {}).missing).toEqual([`leaf: ${dropped}`]);
  });

  it("does not let an output exception excuse a missing target policy", () => {
    const root = fixture([CommandPermissionsAnnotation.key]);
    const exceptions = { [CommandOutputAnnotation.key]: new Map([["leaf", "streaming"]]) };
    expect(adoptionGaps(root, exceptions).missing).toEqual([`leaf: ${TargetPolicyAnnotation.key}`]);
  });

  it("fails an exception for a command that now declares the fact", () => {
    const root = fixture(REQUIRED_FACTS);
    const exceptions = { [CommandOutputAnnotation.key]: new Map([["leaf", "not-yet-declared"]]) };
    expect(adoptionGaps(root, exceptions).stale).toEqual([`leaf: ${CommandOutputAnnotation.key}`]);
  });

  it("fails an exception for a command that no longer exists", () => {
    const root = fixture(REQUIRED_FACTS);
    const exceptions = { [CommandOutputAnnotation.key]: new Map([["gone", "not-yet-declared"]]) };
    expect(adoptionGaps(root, exceptions).stale).toEqual([`gone: ${CommandOutputAnnotation.key}`]);
  });
});
