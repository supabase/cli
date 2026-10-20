import { describe, expect, it } from "vitest";

import { rootCommandForFeatures } from "../../cli/root.ts";
import { bareRemoteOperand, joinRemoteOperands, type RemoteArgvLeaf } from "./remote-argv.ts";
import { prepareCliArgs } from "./run.ts";

const REF = "abcdefghijklmnopqrst";
const URL = "postgresql://postgres:secret@db.example.com:5432/postgres";

const noOperands: RemoteArgvLeaf = {
  pathLength: 2,
  operandCapacity: 0,
  consumesNextToken: (token) => token === "--password" || token === "-p",
};
const oneOperand: RemoteArgvLeaf = { ...noOperands, operandCapacity: 1 };
const variadic: RemoteArgvLeaf = { ...noOperands, operandCapacity: Infinity };

describe("joinRemoteOperands", () => {
  const cases: ReadonlyArray<{
    readonly name: string;
    readonly leaf: RemoteArgvLeaf;
    readonly args: ReadonlyArray<string>;
    readonly expected: ReadonlyArray<string>;
  }> = [
    {
      name: "joins a branch name for a command with no operands",
      leaf: noOperands,
      args: ["db", "push", "--remote", "feature-x"],
      expected: ["db", "push", `--remote=feature-x`],
    },
    {
      name: "joins a project ref for a command with no operands",
      leaf: noOperands,
      args: ["db", "push", "--remote", REF],
      expected: ["db", "push", `--remote=${REF}`],
    },
    {
      name: "keeps a project ref as the operand when the command takes one",
      leaf: oneOperand,
      args: ["storage", "ls", "--remote", REF],
      expected: ["storage", "ls", "--remote", REF],
    },
    {
      name: "joins a project ref once the command has more operands than it takes",
      leaf: oneOperand,
      args: ["storage", "ls", "ss:///bucket", "--remote", REF],
      expected: ["storage", "ls", "ss:///bucket", `--remote=${REF}`],
    },
    {
      name: "never joins a project ref for a command with a variable number of operands",
      leaf: variadic,
      args: ["functions", "deploy", "--remote", REF, "hello"],
      expected: ["functions", "deploy", "--remote", REF, "hello"],
    },
    {
      name: "joins a database URL",
      leaf: variadic,
      args: ["functions", "deploy", "--remote", URL],
      expected: ["functions", "deploy", `--remote=${URL}`],
    },
    {
      name: "joins each linked boolean literal",
      leaf: variadic,
      args: ["functions", "deploy", "--remote", "yes", "--remote", "on", "--remote", "1"],
      expected: ["functions", "deploy", "--remote=yes", "--remote=on", "--remote=1"],
    },
    {
      name: "joins a linked boolean literal in any case, as --remote=<literal> reads it",
      leaf: oneOperand,
      args: ["storage", "ls", "--remote", "YES"],
      expected: ["storage", "ls", "--remote=YES"],
    },
    {
      name: "leaves an off literal for the parser to reject",
      leaf: noOperands,
      args: ["db", "push", "--remote", "false"],
      expected: ["db", "push", "--remote", "false"],
    },
    {
      name: "keeps a branch-shaped word as the operand when the command takes one",
      leaf: oneOperand,
      args: ["storage", "ls", "--remote", "feature-x"],
      expected: ["storage", "ls", "--remote", "feature-x"],
    },
    {
      name: "joins a branch-shaped word once the command has more operands than it takes",
      leaf: oneOperand,
      args: ["storage", "ls", "ss:///bucket", "--remote", "feature-x"],
      expected: ["storage", "ls", "ss:///bucket", "--remote=feature-x"],
    },
    {
      name: "never joins for a command with a variable number of operands",
      leaf: variadic,
      args: ["functions", "deploy", "--remote", "feature-x", "hello"],
      expected: ["functions", "deploy", "--remote", "feature-x", "hello"],
    },
    {
      name: "does not join a flag",
      leaf: noOperands,
      args: ["db", "push", "--remote", "--dry-run"],
      expected: ["db", "push", "--remote", "--dry-run"],
    },
    {
      name: "does not join a word after --",
      leaf: noOperands,
      args: ["db", "push", "--remote", "--", "feature-x"],
      expected: ["db", "push", "--remote", "--", "feature-x"],
    },
    {
      name: "does not join the next command-path segment",
      leaf: noOperands,
      args: ["db", "--remote", "push"],
      expected: ["db", "--remote", "push"],
    },
    {
      name: "does not read another flag's value as a --remote",
      leaf: noOperands,
      args: ["db", "push", "--password", "--remote", "feature-x"],
      expected: ["db", "push", "--password", "--remote", "feature-x"],
    },
    {
      name: "skips the value of another flag when counting operands",
      leaf: oneOperand,
      args: ["storage", "ls", "-p", "secret", "--remote", "feature-x"],
      expected: ["storage", "ls", "-p", "secret", "--remote", "feature-x"],
    },
    {
      name: "keeps an inline value untouched",
      leaf: noOperands,
      args: ["db", "push", "--remote=feature-x", "extra"],
      expected: ["db", "push", "--remote=feature-x", "extra"],
    },
    {
      name: "joins an empty word so the parser reports it",
      leaf: noOperands,
      args: ["db", "push", "--remote", ""],
      expected: ["db", "push", "--remote="],
    },
    {
      name: "joins a word that comes before other flags",
      leaf: noOperands,
      args: ["db", "push", "--remote", "feature-x", "--dry-run"],
      expected: ["db", "push", "--remote=feature-x", "--dry-run"],
    },
  ];

  it.each(cases)("$name", ({ leaf, args, expected }) => {
    expect(joinRemoteOperands(args, leaf)).toEqual(expected);
  });
});

describe("bareRemoteOperand", () => {
  const cases: ReadonlyArray<{
    readonly name: string;
    readonly leaf: RemoteArgvLeaf | undefined;
    readonly args: ReadonlyArray<string>;
    readonly expected: string | undefined;
  }> = [
    {
      name: "returns the branch-shaped word the command took as its operand",
      leaf: oneOperand,
      args: ["db", "pull", "--remote", "feature-x"],
      expected: "feature-x",
    },
    {
      name: "returns a project-ref-shaped word the command took as its operand",
      leaf: oneOperand,
      args: ["db", "pull", "--remote", REF],
      expected: REF,
    },
    {
      name: "skips a word that is a command-path segment",
      leaf: noOperands,
      args: ["seed", "--remote", "buckets"],
      expected: undefined,
    },
    {
      name: "skips a path segment that follows another path segment",
      leaf: noOperands,
      args: ["db", "--remote", "push"],
      expected: undefined,
    },
    {
      name: "counts path segments past another flag's value",
      leaf: oneOperand,
      args: ["db", "-p", "secret", "pull", "--remote", "feature-x"],
      expected: "feature-x",
    },
    {
      name: "treats every word as an operand when the command is unknown",
      leaf: undefined,
      args: ["seed", "--remote", "buckets"],
      expected: "buckets",
    },
    {
      name: "skips a word that cannot name a branch",
      leaf: oneOperand,
      args: ["storage", "ls", "--remote", "ss:///bucket"],
      expected: undefined,
    },
    {
      name: "skips a flag",
      leaf: oneOperand,
      args: ["db", "pull", "--remote", "--dry-run"],
      expected: undefined,
    },
    {
      name: "skips a word after --",
      leaf: oneOperand,
      args: ["db", "pull", "--remote", "--", "feature-x"],
      expected: undefined,
    },
    {
      name: "ignores an inline value",
      leaf: oneOperand,
      args: ["db", "pull", "--remote=feature-x", "other"],
      expected: undefined,
    },
  ];

  it.each(cases)("$name", ({ leaf, args, expected }) => {
    expect(bareRemoteOperand(args, leaf)).toBe(expected);
  });
});

describe("prepareCliArgs argv", () => {
  const root = rootCommandForFeatures();
  const cases: ReadonlyArray<{
    readonly name: string;
    readonly args: ReadonlyArray<string>;
    readonly expected: ReadonlyArray<string>;
  }> = [
    {
      name: "joins a branch for db push",
      args: ["db", "push", "--remote", "feature-x"],
      expected: ["db", "push", "--remote=feature-x"],
    },
    {
      name: "joins a branch after global flags and their values",
      args: ["--profile", "staging", "db", "push", "--remote", "feature-x", "--dry-run"],
      expected: ["--profile", "staging", "db", "push", "--remote=feature-x", "--dry-run"],
    },
    {
      name: "joins a ref for storage ls, which takes one operand",
      args: ["storage", "ls", "--remote", REF, "ss:///bucket"],
      expected: ["storage", "ls", `--remote=${REF}`, "ss:///bucket"],
    },
    {
      name: "leaves a bare --remote before storage ls's own operand",
      args: ["storage", "ls", "--remote", "ss:///bucket"],
      expected: ["storage", "ls", "--remote", "ss:///bucket"],
    },
    {
      name: "joins a database URL for functions deploy, whose operands are variable",
      args: ["functions", "deploy", "--remote", URL, "hello"],
      expected: ["functions", "deploy", `--remote=${URL}`, "hello"],
    },
    {
      name: "leaves a project-ref-shaped word for functions deploy, which may be a function name",
      args: ["functions", "deploy", "--remote", REF, "hello"],
      expected: ["functions", "deploy", "--remote", REF, "hello"],
    },
    {
      name: "leaves a project-ref-shaped word for db pull, which may be a migration name",
      args: ["db", "pull", "--remote", REF],
      expected: ["db", "pull", "--remote", REF],
    },
    {
      name: "joins for seed's persistent --remote after the subcommand",
      args: ["seed", "buckets", "--remote", "feature-x"],
      expected: ["seed", "buckets", "--remote=feature-x"],
    },
    {
      name: "joins for seed's persistent --remote before the subcommand",
      args: ["seed", "--remote", "feature-x", "buckets"],
      expected: ["seed", "--remote=feature-x", "buckets"],
    },
    {
      name: "never swallows the subcommand name after a bare --remote",
      args: ["seed", "--remote", "buckets"],
      expected: ["seed", "--remote", "buckets"],
    },
    {
      name: "joins a branch-shaped word for gen types, whose legacy language operand is hidden",
      args: ["gen", "types", "--remote", "feature-x"],
      expected: ["gen", "types", "--remote=feature-x"],
    },
    {
      name: "joins a ref for gen types",
      args: ["gen", "types", "--remote", REF],
      expected: ["gen", "types", `--remote=${REF}`],
    },
    {
      name: "keeps gen types's legacy language written before a bare --remote",
      args: ["gen", "types", "typescript", "--remote"],
      expected: ["gen", "types", "typescript", "--remote"],
    },
    {
      name: "joins a branch-shaped word after gen types's legacy language",
      args: ["gen", "types", "typescript", "--remote", "feature-x"],
      expected: ["gen", "types", "typescript", "--remote=feature-x"],
    },
    {
      name: "leaves commands without a remote flag alone",
      args: ["link", "--remote", "feature-x"],
      expected: ["link", "--remote", "feature-x"],
    },
    {
      name: "leaves argv without --remote alone",
      args: ["db", "push", "--dry-run"],
      expected: ["db", "push", "--dry-run"],
    },
  ];

  it.each(cases)("$name", ({ args, expected }) => {
    expect(prepareCliArgs(root, args).args).toEqual(expected);
  });
});

describe("prepareCliArgs bareRemoteOperand on the real command tree", () => {
  const root = rootCommandForFeatures();
  const operandOf = (raw: ReadonlyArray<string>) => prepareCliArgs(root, raw).bareRemoteOperand;

  it.each([
    { name: "seed's subcommand", args: ["seed", "--remote", "buckets"] },
    { name: "db's subcommand", args: ["db", "--remote", "push"] },
  ])("does not read $name as an operand", ({ args }) => {
    expect(operandOf(args)).toBeUndefined();
  });

  it("reads db pull's migration-name operand, which may be a branch", () => {
    expect(operandOf(["db", "pull", "--remote", "feature-x"])).toBe("feature-x");
  });

  it("reads a project-ref-shaped word as db pull's operand rather than joining it", () => {
    expect(operandOf(["db", "pull", "--remote", REF])).toBe(REF);
  });

  it("reads no operand from gen types, whose legacy language operand is hidden", () => {
    expect(operandOf(["gen", "types", "--remote", "feature-x"])).toBeUndefined();
  });

  it("finds nothing once every word is joined into --remote=<word>", () => {
    expect(operandOf(["db", "push", "--remote", "feature-x"])).toBeUndefined();
  });
});
