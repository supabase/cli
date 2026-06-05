import { findProjectPaths } from "@supabase/config";
import { Effect, FileSystem } from "effect";
import * as SmolToml from "smol-toml";

/**
 * Which optional `*pointer` sections are actually present in `config.toml`.
 *
 * Go models `db.ssl_enforcement`, `storage.image_transformation`, and
 * `storage.s3_protocol` as `*pointer` fields that are `nil` unless the user
 * declares them — and `config push` skips them entirely when nil. But
 * `@supabase/config` decodes all three to a defaulted struct (e.g.
 * `{ enabled: false }`) whether or not the section appears, so their presence
 * can't be recovered from the decoded config. We therefore re-read the raw
 * `config.toml`/`.json` document and check key presence directly, matching Go's
 * nil-pointer skip semantics.
 *
 * Remote overrides: if a `[remotes.<name>]` block's `project_id` matches the
 * target ref, a section declared only under that remote also counts as present
 * (Go merges the remote section over the base before the nil check).
 */
export interface LegacyConfigPushPresence {
  readonly sslEnforcement: boolean;
  readonly imageTransformation: boolean;
  readonly s3Protocol: boolean;
}

const ABSENT: LegacyConfigPushPresence = {
  sslEnforcement: false,
  imageTransformation: false,
  s3Protocol: false,
};

type RawDoc = { readonly [key: string]: unknown };

function asRecord(value: unknown): RawDoc | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as RawDoc)
    : undefined;
}

/** Best-effort parse of the raw config document; returns `undefined` on any error. */
function parseDocument(configPath: string, content: string): unknown {
  try {
    return configPath.endsWith(".json") ? JSON.parse(content) : SmolToml.parse(content);
  } catch {
    return undefined;
  }
}

function presenceIn(doc: RawDoc | undefined): LegacyConfigPushPresence {
  const db = asRecord(doc?.["db"]);
  const storage = asRecord(doc?.["storage"]);
  return {
    sslEnforcement: db?.["ssl_enforcement"] !== undefined,
    imageTransformation: storage?.["image_transformation"] !== undefined,
    s3Protocol: storage?.["s3_protocol"] !== undefined,
  };
}

/**
 * Reads the raw config document and reports which optional pointer sections are
 * declared (base config OR a matching `[remotes.<ref>]` block). Returns all
 * `false` when no config file exists.
 */
export const loadConfigPresence = Effect.fn("legacy.config.push.raw-presence")(function* (
  cwd: string,
  ref: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const paths = yield* findProjectPaths(cwd);
  if (paths === null) {
    return ABSENT;
  }
  const content = yield* fs.readFileString(paths.configPath).pipe(Effect.orElseSucceed(() => ""));
  const doc = parseDocument(paths.configPath, content);

  const base = presenceIn(asRecord(doc));

  // Fold in any matching remote block's declarations.
  let merged = base;
  const remotes = asRecord(asRecord(doc)?.["remotes"]);
  if (remotes !== undefined) {
    for (const remote of Object.values(remotes)) {
      const r = asRecord(remote);
      if (r?.["project_id"] === ref) {
        const rp = presenceIn(r);
        merged = {
          sslEnforcement: merged.sslEnforcement || rp.sslEnforcement,
          imageTransformation: merged.imageTransformation || rp.imageTransformation,
          s3Protocol: merged.s3Protocol || rp.s3Protocol,
        };
      }
    }
  }
  return merged;
});
