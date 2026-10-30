import { afterEach, vi } from "vitest";
import { Effect, FileSystem, Option, Redacted, Schema } from "effect";

import { PINNED_ENV_PREFIXES } from "./config-env-pins.ts";

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

const encodeGolden = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown, { space: 2 }));
const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));

/**
 * Stable golden serialization: sorted keys, `Option`/`undefined` collapsed to value/`null`, `Set`
 * as sorted array, functions dropped, and each `redactions` key (e.g. a temp workdir) replaced
 * by its placeholder.
 */
export const goldenJson = Effect.fnUntraced(function* (
  value: unknown,
  redactions: Readonly<Record<string, string>> = {},
) {
  const fs = yield* FileSystem.FileSystem;
  let text = `${yield* encodeGolden(normalize(value))}\n`;
  for (const [needle, placeholder] of Object.entries(redactions)) {
    const resolved = yield* fs.realPath(needle).pipe(Effect.orElseSucceed(() => needle));
    for (const variant of new Set([needle, resolved])) {
      text = text.replaceAll((yield* encodeJson(variant)).slice(1, -1), placeholder);
    }
  }
  return text;
});
