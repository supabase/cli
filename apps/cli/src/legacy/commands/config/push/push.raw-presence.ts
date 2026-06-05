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
 * `[remotes.*]` blocks need no special handling here: the handler aborts before
 * this runs when a remote block targets the ref (see matchesRemoteProjectRef),
 * so only the base config's sections are ever inspected.
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
 * declared in the base config. Returns all `false` when no config file exists.
 */
export const loadConfigPresence = Effect.fn("legacy.config.push.raw-presence")(function* (
  cwd: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const paths = yield* findProjectPaths(cwd);
  if (paths === null) {
    return ABSENT;
  }
  const content = yield* fs.readFileString(paths.configPath).pipe(Effect.orElseSucceed(() => ""));
  const doc = parseDocument(paths.configPath, content);
  return presenceIn(asRecord(doc));
});
