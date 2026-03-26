import { mkdir } from "node:fs/promises";
import { Schema } from "effect";
import { ProjectConfigSchema } from "../src/base.ts";

const document = Schema.toJsonSchemaDocument(ProjectConfigSchema);
const json = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  ...document.schema,
  ...(Object.keys(document.definitions).length > 0 ? { $defs: document.definitions } : {}),
};

await mkdir("./dist", { recursive: true });
await Bun.write("./dist/schema.json", `${JSON.stringify(json, null, 2)}\n`);
await Bun.$`bun x oxfmt ./dist/schema.json`.quiet();
