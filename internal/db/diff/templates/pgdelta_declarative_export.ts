// This script is executed inside Edge Runtime by the CLI to export a target
// schema as declarative file payloads. It accepts either live DB URLs or
// catalog-file references for SOURCE/TARGET, which enables cached sync flows.
import {
  createPlan,
  deserializeCatalog,
  exportDeclarativeSchema,
} from "npm:@supabase/pg-delta@1.0.0-alpha.17";
import { supabase } from "npm:@supabase/pg-delta@1.0.0-alpha.17/integrations/supabase";

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
  supabase.filter = {
    and: [supabase.filter!, schemaFilter],
  } as unknown as typeof supabase.filter;
}

const formatOptionsRaw = Deno.env.get("FORMAT_OPTIONS");
let formatOptions = undefined;
if (formatOptionsRaw) {
  formatOptions = JSON.parse(formatOptionsRaw);
}
try {
  const result = await createPlan(
    await resolveInput(source),
    await resolveInput(target),
    {
      ...supabase,
      skipDefaultPrivilegeSubtraction: true,
    },
  );
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
      integration: supabase,
      formatOptions,
    });
    console.log(
      JSON.stringify(output, (_key, value) =>
        typeof value === "bigint" ? Number(value) : value,
      ),
    );
  }
} catch (e) {
  console.error(e);
  // Force close event loop
  throw new Error("");
}
