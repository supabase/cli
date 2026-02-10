import { schema } from "../src/base.ts";
import { toTypes } from "jsonv-ts";

const json = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  ...schema.toJSON(),
};

const types = toTypes(schema, "SupabaseConfig", {
  type: "interface",
  export: true,
});

await Promise.all([
  Bun.write("./dist/types.d.ts", types),
  Bun.write("./dist/schema.json", JSON.stringify(json, null, 2)),
]);
