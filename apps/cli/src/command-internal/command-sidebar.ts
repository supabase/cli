import { Context, Option } from "effect";
import { Command } from "effect/cli";
/** Sidebar sections in display order; top-level commands pick one with `withSidebar`. */
export const DOCS_SIDEBAR_CATEGORIES = [
  { id: "general", title: "General" },
  { id: "testing", title: "Testing" },
  { id: "generate-types", title: "Generate Types" },
  { id: "database", title: "Database" },
  { id: "migrations", title: "Migrations" },
  { id: "seed", title: "Seed" },
  { id: "inspect", title: "Inspect" },
  { id: "logs", title: "Logs" },
  { id: "organizations", title: "Organizations" },
  { id: "projects", title: "Projects" },
  { id: "config", title: "Config" },
  { id: "branches", title: "Branches" },
  { id: "backups", title: "Backups" },
  { id: "edge-functions", title: "Edge Functions" },
  { id: "secrets", title: "Secrets" },
  { id: "storage", title: "Storage" },
  { id: "authentication", title: "Authentication" },
  { id: "custom-domains", title: "Custom Domains" },
  { id: "vanity-subdomains", title: "Vanity Subdomains" },
  { id: "encryption", title: "Encryption" },
  { id: "network-bans", title: "Network Bans" },
  { id: "network-restrictions", title: "Network Restrictions" },
  { id: "ssl-enforcement", title: "SSL Enforcement" },
  { id: "postgres-config", title: "Postgres Config" },
  { id: "sql-snippets", title: "SQL Snippets" },
  { id: "notebooks", title: "Notebooks" },
  { id: "services", title: "Services" },
  { id: "autocompletion-scripts", title: "Autocompletion Scripts" },
  { id: "telemetry", title: "Telemetry" },
  { id: "feedback", title: "Feedback" },
] as const;

export type DocsSidebarCategory = (typeof DOCS_SIDEBAR_CATEGORIES)[number]["id"];

/**
 * Docs-site sidebar placement. Top-level commands declare a category, which their subcommands
 * inherit; any command may override its sidebar title, which defaults to its short description.
 */
export type CommandSidebar =
  | { readonly category: DocsSidebarCategory; readonly title?: string }
  | { readonly title: string; readonly category?: never };

export class CommandSidebarAnnotation extends Context.Service<
  CommandSidebarAnnotation,
  CommandSidebar
>()("supabase/CommandSidebarAnnotation") {}

export const withSidebar = (sidebar: CommandSidebar) =>
  Command.annotate(CommandSidebarAnnotation, sidebar);

export const readSidebar = (command: Command.Command.Any): Option.Option<CommandSidebar> =>
  Context.getOption(command.annotations, CommandSidebarAnnotation);
