import { Argument, Command, Flag } from "effect/unstable/cli";
import { legacyTestDb } from "./db.handler.ts";

const config = {
  paths: Argument.string("path").pipe(
    Argument.withDescription("Paths to test files or directories."),
    Argument.variadic(),
  ),
  dbUrl: Flag.string("db-url").pipe(
    Flag.withDescription(
      "Tests the database specified by the connection string (must be percent-encoded).",
    ),
    Flag.optional,
  ),
  linked: Flag.boolean("linked").pipe(
    Flag.withDescription("Runs pgTAP tests on the linked project."),
  ),
  local: Flag.boolean("local").pipe(
    Flag.withDescription("Runs pgTAP tests on the local database."),
  ),
} as const;

export const legacyTestDbCommand = Command.make("db", config).pipe(
  Command.withDescription("Run pgTAP tests on the local or linked database."),
  Command.withShortDescription("Run pgTAP tests"),
  Command.withHandler((flags) =>
    legacyTestDb({
      paths: flags.paths.map(String),
      dbUrl: flags.dbUrl,
      linked: flags.linked,
      local: flags.local,
    }),
  ),
);
