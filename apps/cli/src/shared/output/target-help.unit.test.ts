import type { Command } from "effect/cli";
import { describe, expect, it } from "vitest";
import {
  fixtureGroup,
  fixtureLeaf,
  fixtureRoot,
} from "../../../tests/helpers/remote-flag-fixture.ts";
import { rootCommand } from "../../cli/root.ts";
import { helpDocFor } from "../cli/subcommand-flag-suggestions.ts";
import { jsonCliOutputFormatter } from "./json-formatter.ts";
import { textCliOutputFormatter } from "./text-formatter.ts";

const helpFor = (root: Command.Command.Any, path: ReadonlyArray<string>) => {
  let command = root;
  for (const segment of path) {
    const next = command.subcommands
      .flatMap((group) => group.commands)
      .find((candidate) => candidate.name === segment);
    if (next === undefined) throw new Error(`no command ${segment}`);
    command = next;
  }
  const doc = helpDocFor(command, ["supabase", ...path]);
  if (doc === undefined) throw new Error("no help doc");
  return doc;
};

const textHelp = (root: Command.Command.Any, path: ReadonlyArray<string>) =>
  textCliOutputFormatter({ rootCommand: root, args: [] }).formatHelpDoc(helpFor(root, path));

const jsonHelp = (root: Command.Command.Any, path: ReadonlyArray<string>) => {
  const parsed: { doc: Record<string, any> } = JSON.parse(
    jsonCliOutputFormatter({ rootCommand: root, args: [] }).formatHelpDoc(helpFor(root, path)),
  );
  return parsed.doc;
};

const tree = fixtureRoot(
  fixtureGroup(
    "db",
    fixtureLeaf("push", "selectable"),
    fixtureLeaf("start", "local-only"),
    fixtureLeaf("secrets", "hosted"),
    fixtureLeaf("login", "account"),
    fixtureLeaf("legacy", "removed"),
    fixtureGroup("schema", fixtureLeaf("generate", "selectable")),
  ),
);

describe("help target labels", () => {
  it("labels each subcommand row from its target group", () => {
    const text = textHelp(tree, ["db"]);

    expect(text).toMatch(/push\s+The push command\.\s+\[local or remote\]/);
    expect(text).toMatch(/start\s+The start command\.\s+\[local only\]/);
    expect(text).toMatch(/secrets\s+The secrets command\.\s+\[remote only\]/);
  });

  it.each(["login", "legacy", "schema"])("leaves %s unlabelled", (name) => {
    const row = textHelp(tree, ["db"])
      .split("\n")
      .find((line) => line.trimStart().startsWith(`${name} `));

    expect(row).toBeDefined();
    expect(row).not.toContain("[");
  });

  it("labels the rows of the real command tree", () => {
    const text = textCliOutputFormatter({ rootCommand, args: [] }).formatHelpDoc(
      helpFor(rootCommand, ["functions"]),
    );

    expect(text).toMatch(/deploy\s.*\[remote only\]/);
    expect(text).toMatch(/serve\s.*\[local only\]/);
  });

  it("leaves rows unlabelled without a root command to look children up in", () => {
    const text = textCliOutputFormatter().formatHelpDoc(helpFor(tree, ["db"]));

    expect(text).not.toContain("[local or remote]");
  });
});

describe("help TARGET section", () => {
  it("states the selectable default before USAGE", () => {
    const text = textHelp(tree, ["db", "push"]);

    expect(text).toContain(
      "TARGET\n  Local by default. Pass --remote for the linked project, or --remote=<ref|branch|url>.\n\nUSAGE\n",
    );
    expect(text.indexOf("DESCRIPTION")).toBeLessThan(text.indexOf("TARGET"));
  });

  it("states that a hosted command uses the linked project", () => {
    expect(textHelp(tree, ["db", "secrets"])).toContain(
      "TARGET\n  Remote only. Uses the linked project; pass --remote=<ref|branch> for another.\n\nUSAGE\n",
    );
  });

  it("states that a local-only command runs against the local stack", () => {
    expect(textHelp(tree, ["db", "start"])).toContain(
      "TARGET\n  Local only. Runs against the local stack.\n\nUSAGE\n",
    );
  });

  it("drops the --remote advice from a hosted command that has no such flag", () => {
    const root = fixtureRoot(fixtureLeaf("link", "hosted", { withRemote: false }));

    expect(textHelp(root, ["link"])).toContain("TARGET\n  Remote only.\n\nUSAGE\n");
  });

  it.each(["login", "legacy"])("adds no TARGET section to the %s command", (name) => {
    expect(textHelp(tree, ["db", name])).not.toContain("TARGET");
  });

  it("adds no TARGET section to a group", () => {
    expect(textHelp(tree, ["db"])).not.toContain("TARGET");
  });

  it("starts with the section when the command has no description", () => {
    const root = fixtureRoot(fixtureLeaf("push", "selectable", { description: "" }));

    expect(textHelp(root, ["push"]).startsWith("TARGET\n")).toBe(true);
  });
});

describe("help --remote flag row", () => {
  it("shows the full value hint on a selectable command", () => {
    expect(textHelp(tree, ["db", "push"])).toMatch(
      /--remote\[=<ref\|branch\|url>\]\s+Target a remote project\./,
    );
  });

  it("omits the url from the hint on a hosted command", () => {
    const text = textHelp(tree, ["db", "secrets"]);

    expect(text).toMatch(/--remote\[=<ref\|branch>\]\s+Target a remote project\./);
    expect(text).not.toContain("url");
  });

  it("leaves other flags as the default formatter renders them", () => {
    expect(textHelp(tree, ["db", "push"])).toMatch(/--other\s+Another flag\./);
  });
});

describe("JSON help", () => {
  it("reports the target scope and summary of a leaf", () => {
    expect(jsonHelp(tree, ["db", "push"]).target).toEqual({
      scope: "local or remote",
      summary:
        "Local by default. Pass --remote for the linked project, or --remote=<ref|branch|url>.",
    });
  });

  it("reports the target scope of each subcommand row", () => {
    const [group] = jsonHelp(tree, ["db"]).subcommands;
    const scopes = Object.fromEntries(
      group.commands.map((sub: { name: string; target?: { scope: string } }) => [
        sub.name,
        sub.target?.scope,
      ]),
    );

    expect(scopes).toMatchObject({
      push: "local or remote",
      start: "local only",
      secrets: "remote only",
      login: undefined,
    });
  });

  it("names the --remote flag with its value hint", () => {
    const flags: Array<{ name: string }> = jsonHelp(tree, ["db", "push"]).flags;

    expect(flags.map((flag) => flag.name)).toContain("remote[=<ref|branch|url>]");
  });

  it("omits target from an account command", () => {
    expect(jsonHelp(tree, ["db", "login"])).not.toHaveProperty("target");
  });
});
