import { mkdir } from "node:fs/promises";
import { toProjectConfigJsonSchema } from "../src/base.ts";

const json = toProjectConfigJsonSchema();

await mkdir("./dist", { recursive: true });
await Bun.write("./dist/schema.json", `${JSON.stringify(json, null, 2)}\n`);
await Bun.$`bun x oxfmt ./dist/schema.json`.quiet();
