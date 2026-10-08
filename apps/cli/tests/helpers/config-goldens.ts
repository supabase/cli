import { realpathSync } from "node:fs";
import { afterEach, vi } from "vitest";
import { Option, Redacted } from "effect";

const PINNED_ENV_PREFIXES = ["SUPABASE_", "DOTENV_", "NEXT_PUBLIC_SUPABASE_"] as const;

/**
 * Returns a function that replaces the whole `SUPABASE_*`/`DOTENV_*` slice of `process.env` with
 * `values` for the current test; everything is restored after each test.
 */
export function useShellEnvPin(): (values: Readonly<Record<string, string>>) => void {
  afterEach(() => {
    vi.unstubAllEnvs();
  });
  return (values) => {
    for (const name of Object.keys(process.env)) {
      if (PINNED_ENV_PREFIXES.some((prefix) => name.startsWith(prefix))) {
        vi.stubEnv(name, undefined);
      }
    }
    for (const [name, value] of Object.entries(values)) {
      vi.stubEnv(name, value);
    }
  };
}

function compareSerialized(left: unknown, right: unknown): number {
  const leftText = JSON.stringify(left);
  const rightText = JSON.stringify(right);
  if (leftText === rightText) return 0;
  return leftText < rightText ? -1 : 1;
}

function normalize(value: unknown): unknown {
  if (value === undefined) return null;
  if (typeof value === "function") return undefined;
  if (Redacted.isRedacted(value)) return normalize(Redacted.value(value));
  if (Option.isOption(value)) return Option.isSome(value) ? normalize(value.value) : null;
  if (value instanceof Set) return [...value].map(normalize).sort(compareSerialized);
  if (value instanceof Map) return normalize(Object.fromEntries(value));
  if (value instanceof Uint8Array) return Buffer.from(value).toString("base64");
  if (Array.isArray(value)) return value.map(normalize);
  if (typeof value === "object" && value !== null) {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      const normalized = normalize((value as Record<string, unknown>)[key]);
      if (normalized !== undefined) out[key] = normalized;
    }
    return out;
  }
  return value;
}

function resolvedPath(candidate: string): string {
  try {
    return realpathSync(candidate);
  } catch {
    return candidate;
  }
}

/**
 * Stable golden serialization: sorted keys, `Option`/`undefined` collapsed to value/`null`, `Set`
 * as sorted array, functions dropped, and each `redactions` key (e.g. a temp workdir) replaced
 * by its placeholder.
 */
export function goldenJson(
  value: unknown,
  redactions: Readonly<Record<string, string>> = {},
): string {
  let text = `${JSON.stringify(normalize(value), null, 2)}\n`;
  for (const [needle, placeholder] of Object.entries(redactions)) {
    for (const variant of new Set([needle, resolvedPath(needle)])) {
      text = text.replaceAll(JSON.stringify(variant).slice(1, -1), placeholder);
    }
  }
  return text;
}
