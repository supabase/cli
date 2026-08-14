import type { LegacyPgDeltaImplementation } from "../../../../shared/legacy-pgdelta-next-flag.ts";
import type { LegacyPgDeltaRemovalSummary } from "../../shared/legacy-pgdelta-engine.service.ts";

/** Extensions that legacy pg-delta treated as part of its implicit Supabase baseline. */
const LEGACY_IMPLICIT_EXTENSIONS = ["pg_net", "pgcrypto", "uuid-ossp"] as const;

export type LegacyDeclarativeImplicitExtension = (typeof LEGACY_IMPLICIT_EXTENSIONS)[number];

export interface LegacyDeclarativeLoadDiagnostic {
  readonly code: string;
  readonly severity: string;
  readonly message: string;
}

export interface LegacyDeclarativeSqlFile {
  readonly name: string;
  readonly sql: string;
}

export interface LegacyDeclarativeLoadCompatibilityFinding {
  readonly extension: LegacyDeclarativeImplicitExtension;
  /** Normalized routine or extension signature matched in the load diagnostic. */
  readonly signature: string;
  readonly diagnosticMessage: string;
  readonly file?: string;
  readonly line?: number;
}

type LegacyDeclarativeCompatibilityAction = "none" | "repair-extensions" | "stage-next-export";

export interface LegacyDeclarativeCompatibilityGap {
  readonly repairableExtensions: ReadonlyArray<string>;
  readonly extensionIntents: LegacyPgDeltaRemovalSummary["extensionIntents"];
  readonly ambiguousRemovals: ReadonlyArray<string>;
  readonly recommendedAction: LegacyDeclarativeCompatibilityAction;
}

/**
 * Pure control-flow helpers ported from the legacy Go implementation (deleted
 * in CLI-1970; last present at commit 7b469f5b3) and kept free of
 * Effect/services so handler decisions remain unit-testable.
 */

export function legacyResolveDeclarativeMigrationName(name: string, file: string): string {
  return name.length > 0 ? name : file;
}

/** Whether sync applies the generated migration, prompts, or skips. */
export type LegacyDeclarativeApplyDecision = "apply" | "skip" | "prompt";

export function legacyResolveDeclarativeSyncApplyDecision(opts: {
  readonly apply: boolean;
  readonly noApply: boolean;
  readonly yes: boolean;
  readonly tty: boolean;
}): LegacyDeclarativeApplyDecision {
  if (opts.noApply) return "skip";
  if (opts.apply) return "apply";
  if (opts.yes) return "apply";
  if (opts.tty) return "prompt";
  return "skip";
}

const emptyCompatibilityGap = (): LegacyDeclarativeCompatibilityGap => ({
  repairableExtensions: [],
  extensionIntents: [],
  ambiguousRemovals: [],
  recommendedAction: "none",
});

/** Classifies manifest-less pg-delta next removals without performing any I/O. */
export function legacyClassifyDeclarativeCompatibilityGap(opts: {
  readonly implementation: LegacyPgDeltaImplementation;
  readonly manifestPresent: boolean;
  readonly removals: LegacyPgDeltaRemovalSummary;
}): LegacyDeclarativeCompatibilityGap {
  if (opts.implementation !== "next" || opts.manifestPresent) return emptyCompatibilityGap();

  const extensions = [...new Set(opts.removals.extensions)].sort();
  const repairableExtensions = extensions.filter((extension) =>
    LEGACY_IMPLICIT_EXTENSIONS.some((implicit) => implicit === extension),
  );
  const ambiguousRemovals = extensions.filter(
    (extension) => !LEGACY_IMPLICIT_EXTENSIONS.some((implicit) => implicit === extension),
  );
  const extensionIntents = opts.removals.extensionIntents;

  if (extensions.length === 0 && extensionIntents.length === 0) return emptyCompatibilityGap();
  const repairable =
    repairableExtensions.length > 0 &&
    ambiguousRemovals.length === 0 &&
    extensionIntents.length === 0;
  return {
    repairableExtensions,
    extensionIntents,
    ambiguousRemovals,
    recommendedAction: repairable ? "repair-extensions" : "stage-next-export",
  };
}

interface LegacyImplicitExtensionMatch {
  readonly extension: LegacyDeclarativeImplicitExtension;
  readonly signature: string;
  readonly sourcePattern: RegExp;
}

const nonConvergingLoadDiagnosticCodes = new Set(["stuck_statement", "max_rounds_exceeded"]);

function matchImplicitExtension(message: string): LegacyImplicitExtensionMatch | undefined {
  const uuidRoutine = message.match(
    /\bfunction\s+extensions\.(uuid_generate_v[a-zA-Z0-9_]*)\s*\([^)]*\)\s+does not exist\b/i,
  );
  const uuidFunction = uuidRoutine?.[1];
  if (uuidFunction !== undefined) {
    return {
      extension: "uuid-ossp",
      signature: `extensions.${uuidFunction}()`,
      sourcePattern: new RegExp(`\\bextensions\\s*\\.\\s*${uuidFunction}\\s*\\(`, "i"),
    };
  }

  const pgcryptoRoutine = message.match(
    /\bfunction\s+extensions\.(digest|crypt|gen_random_bytes|pgp_[a-zA-Z0-9_]*)\s*\([^)]*\)\s+does not exist\b/i,
  );
  const pgcryptoFunction = pgcryptoRoutine?.[1];
  if (pgcryptoFunction !== undefined) {
    return {
      extension: "pgcrypto",
      signature: `extensions.${pgcryptoFunction}()`,
      sourcePattern: new RegExp(`\\bextensions\\s*\\.\\s*${pgcryptoFunction}\\s*\\(`, "i"),
    };
  }

  const pgNetRoutine = message.match(
    /\bfunction\s+net\.(http_[a-zA-Z0-9_]*)\s*\([^)]*\)\s+does not exist\b/i,
  );
  const pgNetFunction = pgNetRoutine?.[1];
  if (pgNetFunction !== undefined) {
    return {
      extension: "pg_net",
      signature: `net.${pgNetFunction}()`,
      sourcePattern: new RegExp(`\\bnet\\s*\\.\\s*${pgNetFunction}\\s*\\(`, "i"),
    };
  }

  const missingExtension = message.match(
    /\bextension\s+"(pg_net|pgcrypto|uuid-ossp)"\s+does not exist\b/i,
  )?.[1];
  if (missingExtension === undefined) return undefined;
  const extension = LEGACY_IMPLICIT_EXTENSIONS.find(
    (implicit) => implicit === missingExtension.toLowerCase(),
  );
  if (extension === undefined) return undefined;
  return {
    extension,
    signature: `extension "${extension}"`,
    sourcePattern: new RegExp(`(?:"${extension}"|\\b${extension}\\b)`, "i"),
  };
}

/**
 * Masks SQL comments and strings while preserving offsets. Extension declarations
 * are DDL, so occurrences inside comments, quoted values, and dollar bodies must
 * not suppress compatibility guidance.
 */
function maskSqlNonCode(sql: string): string {
  return sql.replaceAll(
    /--[^\r\n]*|\/\*[\s\S]*?\*\/|'(?:''|[^'])*'|\$(?:[a-zA-Z_][\w$]*)?\$[\s\S]*?\$(?:[a-zA-Z_][\w$]*)?\$/g,
    (matched) => matched.replaceAll(/[^\r\n]/g, " "),
  );
}

function maskSqlComments(sql: string): string {
  return sql.replaceAll(/--[^\r\n]*|\/\*[\s\S]*?\*\//g, (matched) =>
    matched.replaceAll(/[^\r\n]/g, " "),
  );
}

function declaredImplicitExtensions(
  files: readonly LegacyDeclarativeSqlFile[],
): ReadonlySet<LegacyDeclarativeImplicitExtension> {
  const declared = new Set<LegacyDeclarativeImplicitExtension>();
  const pattern =
    /\bCREATE\s+EXTENSION\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:"([^"]+)"|([a-zA-Z_][\w$-]*))/gi;
  for (const file of files) {
    for (const match of maskSqlNonCode(file.sql).matchAll(pattern)) {
      const extensionName = (match[1] ?? match[2])?.toLowerCase();
      const extension = LEGACY_IMPLICIT_EXTENSIONS.find((implicit) => implicit === extensionName);
      if (extension !== undefined) declared.add(extension);
    }
  }
  return declared;
}

function locateSignature(
  files: readonly LegacyDeclarativeSqlFile[],
  diagnosticMessage: string,
  pattern: RegExp,
): Pick<LegacyDeclarativeLoadCompatibilityFinding, "file" | "line"> {
  const diagnosticFile = files.find((file) => diagnosticMessage.startsWith(`${file.name}:`));
  const candidates = diagnosticFile === undefined ? files : [diagnosticFile];
  for (const file of candidates) {
    const match = pattern.exec(maskSqlComments(file.sql));
    if (match?.index === undefined) continue;
    return {
      file: file.name,
      line: file.sql.slice(0, match.index).split(/\r\n|\r|\n/).length,
    };
  }
  return {};
}

/**
 * Classifies known legacy implicit-extension misses that prevent a manifestless
 * declarative tree from loading on pg-delta next's isolated desired shadow.
 */
export function legacyClassifyDeclarativeLoadCompatibility(opts: {
  readonly implementation: LegacyPgDeltaImplementation;
  readonly manifestPresent: boolean;
  readonly diagnostics: readonly LegacyDeclarativeLoadDiagnostic[];
  readonly files: readonly LegacyDeclarativeSqlFile[];
}): ReadonlyArray<LegacyDeclarativeLoadCompatibilityFinding> {
  if (opts.implementation !== "next" || opts.manifestPresent) return [];

  const declared = declaredImplicitExtensions(opts.files);
  const findings: LegacyDeclarativeLoadCompatibilityFinding[] = [];
  const seen = new Set<string>();
  for (const diagnostic of opts.diagnostics) {
    if (diagnostic.severity !== "error" || !nonConvergingLoadDiagnosticCodes.has(diagnostic.code)) {
      continue;
    }
    const match = matchImplicitExtension(diagnostic.message);
    if (match === undefined || declared.has(match.extension)) continue;
    const location = locateSignature(opts.files, diagnostic.message, match.sourcePattern);
    const key = `${match.extension}\0${match.signature}\0${location.file ?? ""}\0${location.line ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    findings.push({
      extension: match.extension,
      signature: match.signature,
      diagnosticMessage: diagnostic.message,
      ...location,
    });
  }
  return findings;
}

export const legacyExtensionDeclaration = (extension: string): string =>
  `CREATE EXTENSION IF NOT EXISTS "${extension}" WITH SCHEMA "extensions";`;

export function legacyFormatStagedExportRecommendation(
  gap: LegacyDeclarativeCompatibilityGap,
): string {
  const detected = [
    ...(gap.repairableExtensions.length > 0
      ? [`Legacy-implicit extensions: ${gap.repairableExtensions.join(", ")}`]
      : []),
    ...(gap.ambiguousRemovals.length > 0
      ? [`Extensions: ${gap.ambiguousRemovals.join(", ")}`]
      : []),
    ...(gap.extensionIntents.length > 0
      ? [
          `Extension-managed objects: ${gap.extensionIntents
            .map((intent) => `${intent.extension} ${intent.intentKind} ${intent.key}`)
            .join(", ")}`,
        ]
      : []),
  ];
  return [
    "WARNING: pg-delta next manages schema state that the legacy export did not represent.",
    ...detected,
    "Generate a next-compatible schema into a separate directory, review it, and adopt it when ready:",
    "  supabase db schema declarative generate --local --overwrite \\",
    "    --output supabase/database-next --experimental",
    "",
    "  # review supabase/database-next",
    "  rm -rf supabase/database && mv supabase/database-next supabase/database",
    "  supabase db schema declarative sync --no-apply --experimental",
  ].join("\n");
}
