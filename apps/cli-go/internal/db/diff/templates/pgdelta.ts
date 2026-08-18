import {
  createPlan,
  deserializeCatalog,
  renderPlanFiles,
} from "npm:@supabase/pg-delta@1.0.0-alpha.20";
import { supabase } from "npm:@supabase/pg-delta@1.0.0-alpha.20/integrations/supabase";

async function resolveInput(ref: string | undefined) {
  if (!ref) {
    return null;
  }
  if (ref.startsWith("postgres://") || ref.startsWith("postgresql://")) {
    return ref;
  }
  const json = await Deno.readTextFile(ref);
  return deserializeCatalog(JSON.parse(json));
}

const source = Deno.env.get("SOURCE");
const target = Deno.env.get("TARGET");

const includedSchemas = Deno.env.get("INCLUDED_SCHEMAS");
if (includedSchemas) {
  const schemas = includedSchemas.split(",");
  const schemaFilter = {
    or: [{ "*/schema": schemas }, { "schema/name": schemas }],
  };
  // CompositionPattern `and` is valid FilterDSL; Deno's structural typing is strict on `or` branches.
  supabase.filter = {
    and: [supabase.filter!, schemaFilter],
  } as typeof supabase.filter;
}

const formatOptionsRaw = Deno.env.get("FORMAT_OPTIONS");
const parsedFormatOptions = formatOptionsRaw ? JSON.parse(formatOptionsRaw) : undefined;
// Format the emitted SQL by default with the same sensible settings the
// declarative export uses (`exportDeclarativeSchema` in @supabase/pg-delta:
// `{ ...DEFAULT_OPTIONS, maxWidth: 180, keywordCase: "upper", ...userOptions }`),
// so `db pull` / `db diff` produce readable migrations even when config sets no
// `[experimental.pgdelta] format_options`. The formatter fills DEFAULT_OPTIONS
// for missing keys itself, so only the two overrides are passed here. Setting
// `format_options = "null"` (parsed to `null`) is the explicit opt-out: raw,
// unformatted statements, mirroring declarative export's `formatOptions === null`.
const sqlFormatOptions =
  parsedFormatOptions === null
    ? undefined
    : { maxWidth: 180, keywordCase: "upper", ...parsedFormatOptions };

try {
  const result = await createPlan(
    await resolveInput(source),
    await resolveInput(target),
    {
      ...supabase,
      skipDefaultPrivilegeSubtraction: true,
    },
  );
  // pg-delta >= 1.0.0-alpha.32 groups plan statements into execution-aware
  // `units` with transaction boundaries. `renderPlanFiles` turns those into one
  // numbered SQL file per unit (header comments included). `includeTransactions:
  // false` because the CLI appliers already wrap each migration file in a single
  // transaction (Go and TS implicit extended-protocol batches), so embedded
  // BEGIN/COMMIT would override that file-level boundary. Format options are
  // applied per unit here instead of a manual `formatSqlStatements` pass.
  const files = result
    ? renderPlanFiles(result.plan, {
        includeTransactions: false,
        sqlFormatOptions,
      })
    : [];
  const envelope = files.map((file, index) => ({
    order: index + 1,
    // The unit name is the rendered path minus its numeric prefix and `.sql`
    // extension (e.g. `001_after_enum_values.sql` -> `after_enum_values`).
    name: file.path.replace(/^\d+_/, "").replace(/\.sql$/, ""),
    transactionMode: file.unit.transactionMode,
    sql: file.sql,
  }));
  if (Deno.env.get("PGDELTA_DEBUG")) {
    console.error(
      JSON.stringify({
        statementCount: files.reduce((total, file) => total + file.unit.statements.length, 0),
        fileCount: files.length,
        source: source ? "connected" : "null",
        target: target ? "connected" : "null",
        includedSchemas: includedSchemas ?? null,
        skipDefaultPrivilegeSubtraction: true,
      }),
    );
  }
  console.log(JSON.stringify({ version: 1, files: envelope }));
} catch (e) {
  console.error(e);
  // Emit a sentinel so the CLI runner can distinguish a real script crash from a
  // successful empty diff, even though the forced-exit non-zero code below is
  // suppressed by the "main worker has been destroyed" handling.
  console.error("PGDELTA_SCRIPT_ERROR");
  // Force close event loop
  throw new Error("");
}
// Force close the event loop on the success path too. When SOURCE/TARGET are
// live database URLs the plan opens connections whose keepalive handles can keep
// the Edge Runtime worker alive after the diff has been written, so the container
// never exits and the CLI — which follows this container's logs — hangs
// indefinitely at 0% CPU (supabase/pg-toolbelt#312).
throw new Error("");
