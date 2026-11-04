import { Context, Option } from "effect";
import { Command } from "effect/cli";

/** A docs-site sidebar category: its heading and its position among the categories. */
interface DocsCategoryInfo {
  readonly title: string;
  readonly order: number;
}

/** The closed set of docs-site sidebar categories, in sidebar order. */
export const DOCS_CATEGORIES = {
  general: { title: "General", order: 1 },
  testing: { title: "Testing", order: 2 },
  "generate-types": { title: "Generate Types", order: 3 },
  database: { title: "Database", order: 4 },
  migrations: { title: "Migrations", order: 5 },
  seed: { title: "Seed", order: 6 },
  inspect: { title: "Inspect", order: 7 },
  organizations: { title: "Organizations", order: 8 },
  projects: { title: "Projects", order: 9 },
  config: { title: "Config", order: 10 },
  branches: { title: "Branches", order: 11 },
  "edge-functions": { title: "Edge Functions", order: 12 },
  secrets: { title: "Secrets", order: 13 },
  storage: { title: "Storage", order: 14 },
  authentication: { title: "Authentication", order: 15 },
  "custom-domains": { title: "Custom Domains", order: 16 },
  "vanity-subdomains": { title: "Vanity Subdomains", order: 17 },
  "network-bans": { title: "Network Bans", order: 18 },
  "network-restrictions": { title: "Network Restrictions", order: 19 },
  "ssl-enforcement": { title: "SSL Enforcement", order: 20 },
  "postgres-config": { title: "Postgres Config", order: 21 },
  "sql-snippets": { title: "SQL Snippets", order: 22 },
  notebooks: { title: "Notebooks", order: 23 },
  services: { title: "Services", order: 24 },
  "autocompletion-scripts": { title: "Autocompletion Scripts", order: 25 },
  telemetry: { title: "Telemetry", order: 26 },
  encryption: { title: "Encryption", order: 27 },
  backups: { title: "Backups", order: 28 },
  feedback: { title: "Feedback and Support", order: 29 },
} as const satisfies Record<string, DocsCategoryInfo>;

export type DocsCategory = keyof typeof DOCS_CATEGORIES;

/** A usage example on a command's reference page. `name` defaults to `code`. */
interface CommandDocsExample {
  readonly id: string;
  readonly name?: string;
  readonly code: string;
  readonly response?: string;
}

/** Reference-page metadata for one command; its page title is always the command path. */
export interface CommandDocs {
  readonly category: DocsCategory;
  /** Markdown page body, imported from the command's sibling `*.docs.md`. */
  readonly body?: string;
  readonly examples?: ReadonlyArray<CommandDocsExample>;
  /** The command requires `--experimental`. */
  readonly experimental?: boolean;
  /** The command is kept for compatibility and left out of the published reference. */
  readonly deprecated?: { readonly replacement: string };
}

/** Context key under which a command's docs metadata is stored in `Command.annotations`. */
export class CommandDocsAnnotation extends Context.Service<CommandDocsAnnotation, CommandDocs>()(
  "supabase/CommandDocs",
) {}

/** Declares a command's reference-page metadata for the docs generator. */
export const withDocs = (docs: CommandDocs) => Command.annotate(CommandDocsAnnotation, docs);

/** The docs metadata declared on `command` with {@link withDocs}, if any. */
export function readCommandDocs(command: Command.Command.Any): Option.Option<CommandDocs> {
  return Context.getOption(command.annotations, CommandDocsAnnotation);
}
