import { describe, expect, it } from "@effect/vitest";
import { Command } from "effect/cli";
import { DOCS_SIDEBAR_CATEGORIES, withSidebar } from "../command-internal/command-sidebar.ts";
import type { DocsSidebarCategory } from "../command-internal/command-sidebar.ts";
import { rootCommand } from "../cli/root.ts";
import { docsCommandTree } from "./docs-spec.ts";
import { buildDocsSidebar } from "./docs-sidebar.ts";

interface SidebarNode {
  readonly id?: string;
  readonly title: string;
  readonly items?: ReadonlyArray<SidebarNode>;
}

function commandIds(nodes: ReadonlyArray<SidebarNode>): Array<string> {
  return nodes.flatMap((node) => [
    ...(node.id === undefined ? [] : [node.id]),
    ...commandIds(node.items ?? []),
  ]);
}

function categoryStubs(omit?: DocsSidebarCategory) {
  return DOCS_SIDEBAR_CATEGORIES.filter(({ id }) => id !== omit).map(({ id }) =>
    Command.make(id).pipe(
      Command.withShortDescription(`Manage ${id}`),
      withSidebar({ category: id }),
    ),
  );
}

describe("buildDocsSidebar", () => {
  it("lists every published command once, under the categories in table order", () => {
    const sidebar = buildDocsSidebar(rootCommand);

    expect(sidebar.map((entry) => entry.title)).toEqual([
      "Introduction",
      "Global flags",
      ...DOCS_SIDEBAR_CATEGORIES.map((category) => category.title),
    ]);
    const listed = commandIds(sidebar.filter((entry) => entry.type === "category"));
    expect(listed.toSorted()).toEqual([...docsCommandTree(rootCommand).keys()].toSorted());
  });

  it("places migration subcommands alphabetically after their parent", () => {
    const sidebar = buildDocsSidebar(rootCommand);
    const migrations = sidebar.find((entry) => entry.title === "Migrations");
    const ids = migrations?.type === "category" ? migrations.items.map((item) => item.id) : [];

    expect(ids[0]).toBe("supabase-migration");
    const subcommands = ids.slice(1);
    expect(subcommands.length).toBeGreaterThan(0);
    expect(subcommands.every((id) => id.startsWith("supabase-migration-"))).toBe(true);
    expect(subcommands).toEqual(subcommands.toSorted());
  });

  it("lists descendants flat under the inherited category with title overrides or short descriptions", () => {
    const parent = Command.make("parent").pipe(
      Command.withShortDescription("Parent description"),
      withSidebar({ category: "general" }),
      Command.withSubcommands([
        Command.make("group").pipe(
          Command.withShortDescription("Group description"),
          Command.withSubcommands([
            Command.make("child").pipe(
              Command.withShortDescription("Child description"),
              withSidebar({ title: "Child override" }),
            ),
          ]),
        ),
      ]),
    );
    const root = Command.make("supabase").pipe(
      Command.withSubcommands([...categoryStubs("general"), parent]),
    );

    const general = buildDocsSidebar(root).find((entry) => entry.title === "General");

    expect(general?.type === "category" ? general.items : []).toEqual([
      {
        id: "supabase-parent",
        title: "Parent description",
        slug: "supabase-parent",
        type: "cli-command",
      },
      {
        id: "supabase-parent-group",
        title: "Group description",
        slug: "supabase-parent-group",
        type: "cli-command",
      },
      {
        id: "supabase-parent-group-child",
        title: "Child override",
        slug: "supabase-parent-group-child",
        type: "cli-command",
      },
    ]);
  });

  it("rejects a subcommand that declares a category", () => {
    const parent = Command.make("parent").pipe(
      withSidebar({ category: "general" }),
      Command.withSubcommands([Command.make("child").pipe(withSidebar({ category: "general" }))]),
    );
    const root = Command.make("supabase").pipe(
      Command.withSubcommands([...categoryStubs("general"), parent]),
    );

    expect(() => buildDocsSidebar(root)).toThrow(
      /"supabase-parent-child" declares a sidebar category/,
    );
  });

  it("rejects an uncategorized top-level command", () => {
    const root = Command.make("supabase").pipe(
      Command.withSubcommands([
        ...categoryStubs(),
        Command.make("orphan").pipe(Command.withShortDescription("Orphan")),
      ]),
    );

    expect(() => buildDocsSidebar(root)).toThrow(/"supabase-orphan" has no sidebar category/);
  });

  it("rejects a title longer than 50 characters", () => {
    const root = Command.make("supabase").pipe(
      Command.withSubcommands([
        ...categoryStubs("general"),
        Command.make("wordy").pipe(
          Command.withShortDescription("x".repeat(51)),
          withSidebar({ category: "general" }),
        ),
      ]),
    );

    expect(() => buildDocsSidebar(root)).toThrow(/"supabase-wordy" sidebar title is 51 chars/);
  });

  it("rejects an unused category", () => {
    const root = Command.make("supabase").pipe(Command.withSubcommands(categoryStubs("testing")));

    expect(() => buildDocsSidebar(root)).toThrow(/sidebar category "testing" has no commands/);
  });
});
