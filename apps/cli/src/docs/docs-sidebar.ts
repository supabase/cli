import { Option } from "effect";
import type { Command } from "effect/cli";
import { DOCS_SIDEBAR_CATEGORIES, readSidebar } from "../command-internal/command-sidebar.ts";
import type { DocsSidebarCategory } from "../command-internal/command-sidebar.ts";
import { docsSummary, walkDocsCommands } from "./docs-spec.ts";

/** Hand-written pages listed above the command categories. */
const DOCS_SIDEBAR_PAGES: ReadonlyArray<{ readonly id: string; readonly title: string }> = [
  { id: "introduction", title: "Introduction" },
  { id: "global-flags", title: "Global flags" },
];

/** Longest sidebar title the docs site renders on one line. */
const DOCS_SIDEBAR_TITLE_MAX_LENGTH = 50;

interface DocsSidebarPage {
  readonly title: string;
  readonly id: string;
  readonly slug: string;
  readonly isFunc: false;
  readonly type: "markdown";
}

interface DocsSidebarCommand {
  readonly id: string;
  readonly title: string;
  readonly slug: string;
  readonly type: "cli-command";
}

interface DocsSidebarSection {
  readonly type: "category";
  readonly title: string;
  readonly items: ReadonlyArray<DocsSidebarCommand>;
}

export type DocsSidebarEntry = DocsSidebarPage | DocsSidebarSection;

/**
 * Builds the docs-site sidebar (`common-cli-sections.json`) from the published command tree.
 * Every command is listed flat under its top-level command's category.
 */
export function buildDocsSidebar(root: Command.Command.Any): ReadonlyArray<DocsSidebarEntry> {
  const sections = new Map<DocsSidebarCategory, Array<DocsSidebarCommand>>();
  const problems: Array<string> = [];
  let category: DocsSidebarCategory | undefined;

  walkDocsCommands(root, (command, path) => {
    const id = path.join("-");
    const sidebar = readSidebar(command);
    const declared =
      Option.isSome(sidebar) && "category" in sidebar.value ? sidebar.value.category : undefined;
    if (path.length === 2) {
      category = declared;
      if (category === undefined) {
        problems.push(
          `"${id}" has no sidebar category: annotate it with withSidebar({ category }).`,
        );
        return;
      }
    } else if (declared !== undefined) {
      problems.push(`"${id}" declares a sidebar category; only top-level commands may.`);
    }
    if (category === undefined) return;

    const title =
      Option.isSome(sidebar) && sidebar.value.title !== undefined
        ? sidebar.value.title
        : docsSummary(command);
    if (title.length > DOCS_SIDEBAR_TITLE_MAX_LENGTH) {
      problems.push(
        `"${id}" sidebar title is ${title.length} chars (max ${DOCS_SIDEBAR_TITLE_MAX_LENGTH}): set withSidebar({ title }) instead of changing the short description.`,
      );
    }

    const items = sections.get(category) ?? [];
    items.push({ id, title, slug: id, type: "cli-command" });
    sections.set(category, items);
  });

  for (const { id } of DOCS_SIDEBAR_CATEGORIES) {
    if (!sections.has(id))
      problems.push(
        `sidebar category "${id}" has no commands: remove it or annotate a command with it.`,
      );
  }
  if (problems.length > 0) {
    throw new Error(`docs-sidebar.ts: the sidebar cannot be built:\n  ${problems.join("\n  ")}`);
  }

  return [
    ...DOCS_SIDEBAR_PAGES.map(({ id, title }): DocsSidebarPage => ({
      title,
      id,
      slug: id,
      isFunc: false,
      type: "markdown",
    })),
    ...DOCS_SIDEBAR_CATEGORIES.map(({ id, title }): DocsSidebarSection => ({
      type: "category",
      title,
      items: sections.get(id) ?? [],
    })),
  ];
}

export function stringifyDocsSidebar(sidebar: ReadonlyArray<DocsSidebarEntry>): string {
  return `${JSON.stringify(sidebar, null, 2)}\n`;
}
