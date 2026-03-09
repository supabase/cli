// This script is executed inside Edge Runtime by the CLI to export a target
// schema as declarative file payloads. It accepts either live DB URLs or
// catalog-file references for SOURCE/TARGET, which enables cached sync flows.
import {
  createPlan,
  exportDeclarativeSchema,
} from "npm:@supabase/pg-delta@1.0.0-alpha.5";
import { supabase } from "npm:@supabase/pg-delta@1.0.0-alpha.5/integrations/supabase";

const source = Deno.env.get("SOURCE");
const target = Deno.env.get("TARGET");

const includedSchemas = Deno.env.get("INCLUDED_SCHEMAS");
if (includedSchemas) {
  const schemaFilter = { schema: includedSchemas.split(",") };
  supabase.filter = supabase.filter
    ? { and: [supabase.filter, schemaFilter] }
    : schemaFilter;
}
supabase.role = "postgres";

const formatOptionsRaw = Deno.env.get("FORMAT_OPTIONS");
let formatOptions = undefined;
if (formatOptionsRaw) {
  formatOptions = JSON.parse(formatOptionsRaw);
}

try {
  const result = await createPlan(source, target, {
    ...supabase,
    skipDefaultPrivilegeSubtraction: true,
  });
  if (!result) {
    console.log(
      JSON.stringify({
        version: 1,
        mode: "declarative",
        files: [],
      }),
    );
  } else {
    const output = exportDeclarativeSchema(result, {
      formatOptions,
    });
    console.log(JSON.stringify(output));
  }
} catch (e) {
  console.error(e);
  // Force close event loop
  throw new Error("");
}
