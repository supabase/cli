import { mkdir } from "node:fs/promises";
import { toCliConfigJsonSchema } from "../src/base.ts";
import { toProjectConfigJsonSchema } from "../src/project-config/project-schema.ts";

async function renderJsonSchema(outputPath: string, json: unknown): Promise<void> {
  const schema = `${JSON.stringify(json, null, 2)}\n`;

  const formatter = Bun.spawn(["bun", "x", "oxfmt", `--stdin-filepath=${outputPath}`], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  await formatter.stdin.write(schema);
  await formatter.stdin.end();

  const [exitCode, formatted, stderr] = await Promise.all([
    formatter.exited,
    new Response(formatter.stdout).text(),
    new Response(formatter.stderr).text(),
  ]);
  if (exitCode !== 0) {
    throw new Error(`oxfmt failed with exit code ${exitCode}: ${stderr.trim()}`);
  }

  await mkdir("./dist", { recursive: true });
  await Bun.write(outputPath, formatted);
}

await renderJsonSchema("./dist/schema.json", toCliConfigJsonSchema());
await renderJsonSchema("./dist/project-schema.json", toProjectConfigJsonSchema());
