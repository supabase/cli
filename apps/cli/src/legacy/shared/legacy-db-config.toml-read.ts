import { Effect, type FileSystem, Option, type Path } from "effect";
import * as SmolToml from "smol-toml";

/**
 * Subset of `supabase/config.toml` the db-config resolver needs. Read
 * tolerantly (mirrors `config push`'s raw-presence reader): a missing or
 * malformed file yields defaults rather than failing, matching how Go falls
 * back to `config.NewConfig()` defaults.
 */
interface LegacyDbTomlValues {
  /** `[db] port`, default 54322 (`packages/config/src/db.ts`). */
  readonly port: number;
  /** `[db] shadow_port`, default 54320. */
  readonly shadowPort: number;
  /** `[db] password`, runtime default `"postgres"` (not in the config schema). */
  readonly password: string;
  /** `[db.pooler] connection_string`, used by the linked pooler fallback. */
  readonly poolerConnectionString: Option.Option<string>;
  /** top-level `project_id`, used to name the local docker network. */
  readonly projectId: Option.Option<string>;
}

const DEFAULT_PORT = 54322;
const DEFAULT_SHADOW_PORT = 54320;
const DEFAULT_PASSWORD = "postgres";

type RawDoc = { readonly [key: string]: unknown };

function asRecord(value: unknown): RawDoc | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as RawDoc)
    : undefined;
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function nonEmptyString(value: unknown): Option.Option<string> {
  return typeof value === "string" && value.length > 0 ? Option.some(value) : Option.none();
}

/**
 * Reads `<workdir>/supabase/config.toml` and extracts the db connection subtree.
 * Never fails — any read/parse error returns the default values. `fs`/`path` are
 * passed in so the resolver can capture them once and keep its own `R` at `never`.
 */
export const legacyReadDbToml = Effect.fnUntraced(function* (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  workdir: string,
) {
  const configPath = path.join(workdir, "supabase", "config.toml");
  const content = yield* fs.readFileString(configPath).pipe(Effect.orElseSucceed(() => ""));

  let doc: RawDoc | undefined;
  try {
    doc = asRecord(SmolToml.parse(content));
  } catch {
    doc = undefined;
  }

  const db = asRecord(doc?.["db"]);
  const pooler = asRecord(db?.["pooler"]);

  const values: LegacyDbTomlValues = {
    port: numberOr(db?.["port"], DEFAULT_PORT),
    shadowPort: numberOr(db?.["shadow_port"], DEFAULT_SHADOW_PORT),
    password: typeof db?.["password"] === "string" ? db["password"] : DEFAULT_PASSWORD,
    poolerConnectionString: nonEmptyString(pooler?.["connection_string"]),
    projectId: nonEmptyString(doc?.["project_id"]),
  };
  return values;
});
