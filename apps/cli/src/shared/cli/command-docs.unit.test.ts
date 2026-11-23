import { describe, expect, it } from "vitest";
import { Command } from "effect/cli";
import { findCommand } from "./command-docs.ts";

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
