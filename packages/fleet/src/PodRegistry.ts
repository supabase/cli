import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { PodManifest } from "./PodManifest.ts";

/**
 * Persists pod manifests on disk, one per pod directory: `podsRoot/<id>/pod.json`.
 * The pod's data directory lives alongside it at `podsRoot/<id>/data`.
 */
export class PodRegistry {
  constructor(private readonly podsRoot: string) {}

  podDir(id: string): string {
    return join(this.podsRoot, id);
  }

  dataDir(id: string): string {
    return join(this.podsRoot, id, "data");
  }

  async read(id: string): Promise<PodManifest | undefined> {
    const raw = await readFile(join(this.podDir(id), "pod.json"), "utf8").catch(() => undefined);
    return raw === undefined ? undefined : (JSON.parse(raw) as PodManifest);
  }

  async write(manifest: PodManifest): Promise<void> {
    await mkdir(this.podDir(manifest.id), { recursive: true });
    await writeFile(join(this.podDir(manifest.id), "pod.json"), JSON.stringify(manifest, null, 2));
  }

  async list(): Promise<PodManifest[]> {
    const entries = await readdir(this.podsRoot).catch(() => [] as string[]);
    const manifests = await Promise.all(entries.map((id) => this.read(id)));
    return manifests.filter((m): m is PodManifest => m !== undefined);
  }

  async remove(id: string): Promise<void> {
    await rm(this.podDir(id), { recursive: true, force: true });
  }
}
