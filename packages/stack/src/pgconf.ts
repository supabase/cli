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

export async function installMicroProfile(pgdata: string): Promise<void> {
  await writeFile(join(pgdata, "micro.conf"), buildMicroConf());
  const podConf = join(pgdata, "pod.conf");
  const existing = await readFile(podConf, "utf8").catch(() => undefined);
  if (existing === undefined) {
    await writeFile(podConf, buildPodConf([]));
  }
  const mainPath = join(pgdata, "postgresql.conf");
  const main = await readFile(mainPath, "utf8");
  if (!main.includes("include_if_exists = 'micro.conf'")) {
    await writeFile(mainPath, main + INCLUDE_BLOCK);
  }
}

export async function readPreloadLibraries(pgdata: string): Promise<string[]> {
  const content = await readFile(join(pgdata, "pod.conf"), "utf8").catch(() => "");
  const match = content.match(/^shared_preload_libraries = '([^']*)'/m);
  if (!match || match[1] === "") return [];
  return match[1].split(",");
}

export async function writePreloadLibraries(
  pgdata: string,
  libs: ReadonlyArray<string>,
): Promise<void> {
  await writeFile(join(pgdata, "pod.conf"), buildPodConf(libs));
}
