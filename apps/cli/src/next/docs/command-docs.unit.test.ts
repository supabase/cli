import { describe, expect, it } from "vitest";
import { Command } from "effect/unstable/cli";
import { collectCommands, findCommand } from "./command-docs.ts";

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

function makeTree() {
  const login = Command.make("login").pipe(Command.withDescription("Log in to Supabase"));
  const logout = Command.make("logout").pipe(Command.withDescription("Log out of Supabase"));
  const root = Command.make("supabase").pipe(
    Command.withDescription("Supabase CLI"),
    Command.withSubcommands([login, logout]),
  );
  return { root, login, logout };
}

function makeDeepTree() {
  const child = Command.make("branch").pipe(Command.withDescription("Manage branches"));
  const mid = Command.make("db").pipe(
    Command.withDescription("Database commands"),
    Command.withSubcommands([child]),
  );
  const root = Command.make("supabase").pipe(
    Command.withDescription("Supabase CLI"),
    Command.withSubcommands([mid]),
  );
  return { root, mid, child };
}

// ---------------------------------------------------------------------------
// findCommand
// ---------------------------------------------------------------------------

describe("findCommand", () => {
  it("returns the root command when path is empty", () => {
    const { root } = makeTree();
    const result = findCommand(root, []);
    expect(result).toBe(root);
  });

  it("navigates to a direct subcommand by name", () => {
    const { root } = makeTree();
    const result = findCommand(root, ["login"]);
    expect(result).toBeDefined();
    expect(result?.name).toBe("login");
  });

  it("returns undefined for an unknown subcommand name", () => {
    const { root } = makeTree();
    const result = findCommand(root, ["unknown"]);
    expect(result).toBeUndefined();
  });

  it("navigates to a deeply nested subcommand", () => {
    const { root } = makeDeepTree();
    const result = findCommand(root, ["db", "branch"]);
    expect(result).toBeDefined();
    expect(result?.name).toBe("branch");
  });

  it("returns undefined when an intermediate segment is unknown", () => {
    const { root } = makeDeepTree();
    const result = findCommand(root, ["unknown", "branch"]);
    expect(result).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// collectCommands
// ---------------------------------------------------------------------------

describe("collectCommands", () => {
  it("includes the root command itself", () => {
    const { root } = makeTree();
    const results = collectCommands(root, ["supabase"]);
    expect(results[0]).toMatchObject({ commandPath: ["supabase"] });
    expect(results[0]?.command.name).toBe("supabase");
  });

  it("returns all commands in a flat list", () => {
    const { root } = makeTree();
    const results = collectCommands(root, ["supabase"]);
    expect(results).toHaveLength(3);
    const names = results.map((r) => r.command.name);
    expect(names).toContain("supabase");
    expect(names).toContain("login");
    expect(names).toContain("logout");
  });

  it("builds correct commandPath for each entry", () => {
    const { root } = makeTree();
    const results = collectCommands(root, ["supabase"]);
    const loginEntry = results.find((r) => r.command.name === "login");
    expect(loginEntry?.commandPath).toEqual(["supabase", "login"]);
  });

  it("collects deeply nested commands with correct paths", () => {
    const { root } = makeDeepTree();
    const results = collectCommands(root, ["supabase"]);
    expect(results).toHaveLength(3);
    const branchEntry = results.find((r) => r.command.name === "branch");
    expect(branchEntry?.commandPath).toEqual(["supabase", "db", "branch"]);
  });

  it("returns only the root when there are no subcommands", () => {
    const leaf = Command.make("leaf").pipe(Command.withDescription("Leaf command"));
    const results = collectCommands(leaf, ["leaf"]);
    expect(results).toHaveLength(1);
    expect(results[0]?.command.name).toBe("leaf");
  });
});
