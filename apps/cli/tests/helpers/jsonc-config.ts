import { parseJsonc, updateJsonDocument } from "@supabase/config/internal";

export type ConfigPath = ReadonlyArray<string>;

export interface ConfigValueEdit {
  readonly path: ConfigPath;
  readonly value: unknown;
}

const STACK_PORT_KEYS: ReadonlySet<string> = new Set([
  "port",
  "smtp_port",
  "pop3_port",
  "inspector_port",
  "shadow_port",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseConfigObject(text: string): Record<string, unknown> {
  const parsed = parseJsonc(text);
  if (!isRecord(parsed)) {
    throw new Error("config.jsonc did not parse to an object");
  }
  return parsed;
}

function readAt(root: unknown, path: ConfigPath): unknown {
  return path.reduce<unknown>((node, key) => (isRecord(node) ? node[key] : undefined), root);
}

/** Reads the value at `path` from JSONC text; undefined when any segment is absent. */
export function readConfigValue(text: string, path: ConfigPath): unknown {
  return readAt(parseConfigObject(text), path);
}

/** Reads the numeric `port` property of the top-level `section` object. */
export function readSectionPort(text: string, section: string): number {
  const port = readConfigValue(text, [section, "port"]);
  if (typeof port !== "number") {
    throw new Error(`config.jsonc has no numeric ${section}.port (found ${JSON.stringify(port)})`);
  }
  return port;
}

/** Paths of every active (uncommented) numeric stack port property, in document order. */
export function activeStackPortPaths(text: string): ReadonlyArray<ConfigPath> {
  const found: ConfigPath[] = [];
  const walk = (node: unknown, path: ConfigPath): void => {
    if (!isRecord(node)) return;
    for (const [key, value] of Object.entries(node)) {
      if (STACK_PORT_KEYS.has(key) && typeof value === "number") {
        found.push([...path, key]);
      } else {
        walk(value, [...path, key]);
      }
    }
  };
  walk(parseConfigObject(text), []);
  return found;
}

/** Sets values through a comment-preserving JSONC edit, then re-parses to require every assignment landed. */
export function setConfigValues(text: string, edits: ReadonlyArray<ConfigValueEdit>): string {
  const target = structuredClone(parseConfigObject(text));
  for (const { path, value } of edits) {
    const parentPath = path.slice(0, -1);
    const key = path[path.length - 1];
    if (key === undefined) throw new Error("cannot set a value at an empty config path");
    let parent: Record<string, unknown> = target;
    for (const segment of parentPath) {
      const next = parent[segment];
      if (isRecord(next)) {
        parent = next;
      } else {
        const created: Record<string, unknown> = {};
        parent[segment] = created;
        parent = created;
      }
    }
    parent[key] = value;
  }
  const updated = updateJsonDocument(text, target);
  if (updated === undefined) {
    throw new Error(
      `could not edit config.jsonc at ${edits.map((e) => e.path.join(".")).join(", ")}`,
    );
  }
  const reparsed = parseConfigObject(updated);
  for (const { path, value } of edits) {
    const actual = readAt(reparsed, path);
    if (actual !== value) {
      throw new Error(
        `config.jsonc ${path.join(".")} is ${JSON.stringify(actual)} after editing, expected ${JSON.stringify(value)}`,
      );
    }
  }
  return updated;
}
