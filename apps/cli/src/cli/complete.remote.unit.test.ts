import { describe, expect, it } from "vitest";
import { fixtureGroup, fixtureLeaf, fixtureRoot } from "../../tests/helpers/remote-flag-fixture.ts";
import { CompletionDirective, respondToComplete } from "./complete.ts";

const tree = fixtureRoot(
  fixtureGroup(
    "db",
    fixtureLeaf("push", "selectable"),
    fixtureLeaf("pull", "selectable", { positionals: ["optional"] }),
    fixtureLeaf("query", "selectable", { positionals: ["required"] }),
    fixtureLeaf("cp", "selectable", { positionals: ["required", "variadic"] }),
    fixtureLeaf("deploy", "hosted"),
  ),
);

const complete = (...words: ReadonlyArray<string>) =>
  respondToComplete(tree, ["__complete", ...words]);

const names = (...words: ReadonlyArray<string>) =>
  complete(...words)?.candidates.map((candidate) => candidate.name);

const noValueCandidates = { candidates: [], directive: CompletionDirective.NoFileComp };
const positionalCandidates = { candidates: [], directive: CompletionDirective.Default };

const PROJECT_REF = "abcdefghijklmnopqrst";

describe("--remote flag-name completion", () => {
  it("offers --remote= so the next word is typed as its value", () => {
    expect(names("db", "push", "--rem")).toEqual(["--remote="]);
  });

  it("offers --remote= after positionals", () => {
    expect(names("db", "pull", "add_profiles", "--rem")).toEqual(["--remote="]);
  });

  it("asks the shell not to add a space after --remote=", () => {
    expect(complete("db", "push", "--rem")?.directive).toBe(
      CompletionDirective.NoFileComp | CompletionDirective.NoSpace,
    );
  });

  it("keeps the space when other flags are offered next to --remote=", () => {
    expect(names("db", "push", "--")).toContain("--remote=");
    expect(names("db", "push", "--")?.length).toBeGreaterThan(1);
    expect(complete("db", "push", "--")?.directive).toBe(CompletionDirective.NoFileComp);
  });

  it("keeps the space after a flag name that takes no value", () => {
    expect(complete("db", "push", "--ot")?.directive).toBe(CompletionDirective.NoFileComp);
  });

  it("stops offering --remote once it is given", () => {
    expect(names("db", "push", "--remote", "--rem")).toEqual([]);
    expect(names("db", "push", "--remote=feature-x", "--rem")).toEqual([]);
  });
});

describe("--remote= value completion", () => {
  it.each(["--remote=", "--remote=feature-x", "--remote=postgresql://u:p@host:5432/db"])(
    "takes any text after the equals sign and offers no files (%s)",
    (token) => {
      expect(complete("db", "push", token)).toEqual(noValueCandidates);
    },
  );

  it("keeps completing flags after a branch name given with an equals sign", () => {
    expect(names("db", "push", "--remote=feature-x", "--o")).toEqual(["--other"]);
  });
});

describe("the token after a bare --remote", () => {
  it("is the value on a command with no positional", () => {
    expect(complete("db", "push", "--remote", "")).toEqual(noValueCandidates);
    expect(complete("db", "deploy", "--remote", "feat")).toEqual(noValueCandidates);
  });

  it("is the positional while the command has a free positional slot", () => {
    expect(complete("db", "pull", "--remote", "")).toEqual(positionalCandidates);
    expect(complete("db", "query", "--remote", "sel")).toEqual(positionalCandidates);
  });

  it("is the value when it is a project ref or a database URL, even with a free positional slot", () => {
    expect(complete("db", "pull", "--remote", PROJECT_REF)).toEqual(noValueCandidates);
    expect(complete("db", "query", "--remote", "postgresql://u:p@host:5432/db")).toEqual(
      noValueCandidates,
    );
  });

  it("is the value once the positionals are filled", () => {
    expect(complete("db", "pull", "add_profiles", "--remote", "")).toEqual(noValueCandidates);
    expect(complete("db", "query", "select 1", "--remote", "")).toEqual(noValueCandidates);
  });

  it("is a positional when the command takes a variadic one and the word could be an operand", () => {
    expect(complete("db", "cp", "a", "b", "--remote", "")).toEqual(positionalCandidates);
    expect(complete("db", "cp", "a", "--remote", "feat")).toEqual(positionalCandidates);
  });

  it("is the value on a variadic command once it is a project ref", () => {
    expect(complete("db", "cp", "a", "--remote", PROJECT_REF)).toEqual(noValueCandidates);
  });

  it("does not stop flag completion from running after the bare switch", () => {
    expect(names("db", "pull", "--remote", "--o")).toEqual(["--other"]);
  });
});
