import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, expect, test, vi } from "vitest";

const suffixes = vi.hoisted(() => ({ queue: [] as Array<Buffer> }));

vi.mock("node:crypto", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:crypto")>();
  return {
    ...original,
    randomBytes: (size: number) => suffixes.queue.shift() ?? original.randomBytes(size),
  };
});

const { saveCliConfig } = await import("./io-promises.ts");

const NOW = 1_700_000_000_000;
const roots: Array<string> = [];

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});
afterEach(() => vi.useRealTimers());
afterAll(() => Promise.all(roots.map((root) => rm(root, { recursive: true, force: true }))));

test("a temp file another writer already owns is left untouched and the save retries", async () => {
  const root = await mkdtemp(join(tmpdir(), "supabase-config-atomic-"));
  roots.push(root);
  const supabaseDir = join(root, "supabase");
  await mkdir(supabaseDir);
  await writeFile(join(supabaseDir, "config.toml"), 'project_id = "old"\n');
  const foreign = `config.toml.tmp.${NOW}.aaaaaa`;
  await writeFile(join(supabaseDir, foreign), "another writer's content");
  suffixes.queue.push(Buffer.from("aaaaaa", "hex"), Buffer.from("bbbbbb", "hex"));

  await saveCliConfig({ cwd: root, config: { project_id: "new" }, format: "toml" });

  expect(await readFile(join(supabaseDir, foreign), "utf8")).toBe("another writer's content");
  expect(await readFile(join(supabaseDir, "config.toml"), "utf8")).toContain('project_id = "new"');
  expect((await readdir(supabaseDir)).sort()).toEqual([foreign, "config.toml"].sort());
});
