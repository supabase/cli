/**
 * Emits the docs-site CLI sidebar (`common-cli-sections.json`) from the Effect command tree. Run as
 * `bun scripts/generate-docs-sidebar.ts > common-cli-sections.json`.
 */
import process from "node:process";
import { rootCommand } from "../src/cli/root.ts";
import { buildDocsSidebar, stringifyDocsSidebar } from "../src/docs/docs-sidebar.ts";

process.stdout.write(stringifyDocsSidebar(buildDocsSidebar(rootCommand)));
