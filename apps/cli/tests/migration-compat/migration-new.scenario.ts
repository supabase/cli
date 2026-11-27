import type { Path } from "effect";
import type { Scenario } from "./scenario.ts";

function normalizeCreatedPath(stdout: string, workdir: string, path: Path.Path) {
  const matches = [...stdout.matchAll(/"path"\s*:\s*("(?:[^"\\]|\\.)*")/g)];
  const literal = matches[0]?.[1];
  if (matches.length !== 1 || !literal || stdout.indexOf(literal) !== stdout.lastIndexOf(literal)) {
    throw new Error("Expected one migration path field");
  }
  const created: unknown = JSON.parse(literal);
  const prefix = path.join(workdir, "supabase", "migrations") + path.sep;
  if (typeof created !== "string" || !path.isAbsolute(created) || !created.startsWith(prefix)) {
    throw new Error("Expected an absolute migration path inside the invocation workdir");
  }
  const filename = created.slice(prefix.length);
  if (!/^\d{14}_compat\.sql$/.test(filename)) {
    throw new Error("Expected a timestamped compat migration filename");
  }
  return stdout.replace(
    literal,
    '"<workdir>/supabase/migrations/<migration-timestamp>_compat.sql"',
  );
}

export const migrationNew = {
  name: "migration-new",
  argv: ["migration", "new", "--workdir", "<workdir>", "--output-format", "<format>"],
  cases: (["json", "stream-json"] as const).flatMap((format) => [
    {
      name: `${format}/success`,
      format,
      args: ["compat"],
      exitCode: 0,
      routes: {},
      normalizeStdout: normalizeCreatedPath,
    },
    {
      name: `${format}/invalid-name`,
      format,
      args: ["../../../escape"],
      exitCode: 1,
      routes: {},
      normalizeStdout: (stdout: string, _workdir: string, path: Path.Path) => {
        const suffix = (dir: string) =>
          JSON.stringify(`must not escape the ${dir} directory`).slice(1);
        const native = suffix(path.join("supabase", "migrations"));
        if (!stdout.includes(native))
          throw new Error("Expected the native migrations directory in the diagnostic");
        return stdout.replace(native, suffix("supabase/migrations"));
      },
    },
  ]),
} satisfies Scenario;
