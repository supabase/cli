import { mkdir } from "node:fs/promises";
import { toProjectConfigJsonSchema } from "../src/base.ts";

const json = toProjectConfigJsonSchema();
const schema = `${JSON.stringify(json, null, 2)}\n`;

const formatter = Bun.spawn(["bun", "x", "oxfmt", "--stdin-filepath=./dist/schema.json"], {
  stdin: "pipe",
  stdout: "pipe",
  stderr: "pipe",
});
formatter.stdin.write(schema);
formatter.stdin.end();

const [exitCode, formatted, stderr] = await Promise.all([
  formatter.exited,
  new Response(formatter.stdout).text(),
  new Response(formatter.stderr).text(),
]);
if (exitCode !== 0) {
  throw new Error(`oxfmt failed with exit code ${exitCode}: ${stderr.trim()}`);
}

await mkdir("./dist", { recursive: true });
await Bun.write("./dist/schema.json", formatted);
