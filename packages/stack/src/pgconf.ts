import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { buildMicroConf, buildPodConf } from "./micro.ts";

const INCLUDE_BLOCK = [
  "",
  "# --- supabase micro profile (managed; do not edit below) ---",
  "include_if_exists = 'micro.conf'",
  "include_if_exists = 'pod.conf'",
  "",
].join("\n");

// Line-anchored, active (non-commented) include directive only — a commented-out
// line like `#include_if_exists = 'micro.conf'` must NOT count as installed.
const ACTIVE_INCLUDE_RE = /^\s*include_if_exists = 'micro\.conf'/m;
const ACTIVE_POD_INCLUDE_RE = /^\s*include_if_exists = 'pod\.conf'/m;

const PRELOAD_LIBRARIES_RE = /^\s*shared_preload_libraries\s*=\s*['"]([^'"]*)['"]/m;

export async function installMicroProfile(pgdata: string): Promise<void> {
  await writeFile(join(pgdata, "micro.conf"), buildMicroConf());
  const podConf = join(pgdata, "pod.conf");
  const existing = await readFile(podConf, "utf8").catch(() => undefined);
  if (existing === undefined) {
    await writeFile(podConf, buildPodConf([]));
  }
  const mainPath = join(pgdata, "postgresql.conf");
  const main = await readFile(mainPath, "utf8");
  if (!ACTIVE_INCLUDE_RE.test(main)) {
    await writeFile(mainPath, main + INCLUDE_BLOCK);
  }
}

export async function installPodConfOverlay(pgdata: string): Promise<void> {
  const podConf = join(pgdata, "pod.conf");
  const existing = await readFile(podConf, "utf8").catch(() => undefined);
  if (existing === undefined) {
    await writeFile(podConf, buildPodConf([]));
  }
  const mainPath = join(pgdata, "postgresql.conf");
  const main = await readFile(mainPath, "utf8");
  if (!ACTIVE_POD_INCLUDE_RE.test(main)) {
    const separator = main.endsWith("\n") || main === "" ? "" : "\n";
    await writeFile(mainPath, `${main}${separator}include_if_exists = 'pod.conf'\n`);
  }
}

export async function readPreloadLibraries(pgdata: string): Promise<string[]> {
  const content = await readFile(join(pgdata, "pod.conf"), "utf8").catch(() => "");
  const match = content.match(PRELOAD_LIBRARIES_RE);
  if (!match || match[1] === undefined || match[1] === "") return [];
  return match[1].split(",").map((lib) => lib.trim());
}

export async function writePreloadLibraries(
  pgdata: string,
  libs: ReadonlyArray<string>,
): Promise<void> {
  const podConf = join(pgdata, "pod.conf");
  const existing = await readFile(podConf, "utf8").catch(() => undefined);
  const line = `shared_preload_libraries = '${libs.join(",")}'`;
  if (existing === undefined) {
    await writeFile(podConf, `${line}\n`);
    return;
  }
  if (PRELOAD_LIBRARIES_RE.test(existing)) {
    const updated = existing.replace(PRELOAD_LIBRARIES_RE, line);
    await writeFile(podConf, updated);
    return;
  }
  const separator = existing.endsWith("\n") || existing === "" ? "" : "\n";
  await writeFile(podConf, `${existing}${separator}${line}\n`);
}
