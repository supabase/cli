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

describe("--remote flag-name completion", () => {
  it("offers --remote as a bare switch, never --remote=", () => {
    expect(names("db", "push", "--rem")).toEqual(["--remote"]);
  });

  it("offers --remote after positionals", () => {
    expect(names("db", "pull", "add_profiles", "--rem")).toEqual(["--remote"]);
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
    expect(complete("db", "pull", "--remote", "")).toEqual({
      candidates: [],
      directive: CompletionDirective.Default,
    });
    expect(complete("db", "query", "--remote", "sel")).toEqual({
      candidates: [],
      directive: CompletionDirective.Default,
    });
  });

  it("is the value once the positionals are filled", () => {
    expect(complete("db", "pull", "add_profiles", "--remote", "")).toEqual(noValueCandidates);
    expect(complete("db", "query", "select 1", "--remote", "")).toEqual(noValueCandidates);
  });

  it("is always a positional when the command takes a variadic one", () => {
    expect(complete("db", "cp", "a", "b", "--remote", "")).toEqual({
      candidates: [],
      directive: CompletionDirective.Default,
    });
  });

  it("does not stop flag completion from running after the bare switch", () => {
    expect(names("db", "pull", "--remote", "--o")).toEqual(["--other"]);
  });
});
