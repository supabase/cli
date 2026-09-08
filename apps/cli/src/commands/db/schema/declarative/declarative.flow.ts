import { schemaToCsvField } from "../../../../command-internal/schema-flags.ts";
import {
  declaredSqlExtensions,
  maskSqlComments,
} from "../../shared/pgdelta-declarative-shadow-prep.ts";
import type { PgDeltaRemovalSummary } from "../../shared/pgdelta-engine.service.ts";

/** Extensions that legacy pg-delta treated as part of its implicit Supabase baseline. */
const IMPLICIT_EXTENSIONS = ["pg_net", "pgcrypto", "uuid-ossp"] as const;

type DeclarativeImplicitExtension = (typeof IMPLICIT_EXTENSIONS)[number];

export interface DeclarativeLoadDiagnostic {
  readonly code: string;
  readonly severity: string;
  readonly message: string;
}

export interface DeclarativeSqlFile {
  readonly name: string;
  readonly sql: string;
}

export interface DeclarativeLoadCompatibilityFinding {
  readonly extension: DeclarativeImplicitExtension;
  /** Normalized routine or extension signature matched in the load diagnostic. */
  readonly signature: string;
  readonly diagnosticMessage: string;
  readonly file?: string;
  readonly line?: number;
}

type DeclarativeCompatibilityAction = "none" | "repair-extensions" | "stage-next-export";

export interface DeclarativeCompatibilityGap {
  readonly repairableExtensions: ReadonlyArray<string>;
  readonly extensionIntents: PgDeltaRemovalSummary["extensionIntents"];
  readonly ambiguousRemovals: ReadonlyArray<string>;
  readonly recommendedAction: DeclarativeCompatibilityAction;
}

/**
 * Pure control-flow helpers ported from the legacy Go implementation (deleted
 * in CLI-1970; last present at commit 7b469f5b3) and kept free of
 * Effect/services so handler decisions remain unit-testable.
 */

export function resolveDeclarativeMigrationName(name: string, file: string): string {
  return name.length > 0 ? name : file;
}

/** Whether sync applies the generated migration, prompts, or skips. */
export type DeclarativeApplyDecision = "apply" | "skip" | "prompt";

export function resolveDeclarativeSyncApplyDecision(opts: {
  readonly apply: boolean;
  readonly noApply: boolean;
  readonly yes: boolean;
  readonly tty: boolean;
}): DeclarativeApplyDecision {
  if (opts.noApply) return "skip";
  if (opts.apply) return "apply";
  if (opts.yes) return "apply";
  if (opts.tty) return "prompt";
  return "skip";
}

const emptyCompatibilityGap = (): DeclarativeCompatibilityGap => ({
  repairableExtensions: [],
  extensionIntents: [],
  ambiguousRemovals: [],
  recommendedAction: "none",
});

/** Classifies manifest-less pg-delta removals without performing any I/O. */
export function classifyDeclarativeCompatibilityGap(opts: {
  readonly manifestPresent: boolean;
  readonly removals: PgDeltaRemovalSummary;
}): DeclarativeCompatibilityGap {
  if (opts.manifestPresent) return emptyCompatibilityGap();

  const extensions = [...new Set(opts.removals.extensions)].sort();
  const repairableExtensions = extensions.filter((extension) =>
    IMPLICIT_EXTENSIONS.some((implicit) => implicit === extension),
  );
  const ambiguousRemovals = extensions.filter(
    (extension) => !IMPLICIT_EXTENSIONS.some((implicit) => implicit === extension),
  );
  // Removing a pg_cron job or pgmq queue declaration is an ordinary delete or
  // rename on a maintained tree, not legacy-export evidence: only a dropped
  // extension trips the gate (CLI-2282). Their removals are kept as evidence
  // solely to enumerate the objects a dropped owning extension takes with it.
  const extensionIntents = opts.removals.extensionIntents.filter((intent) =>
    extensions.includes(intent.extension),
  );

  if (extensions.length === 0) return emptyCompatibilityGap();
  const repairable = repairableExtensions.length > 0 && ambiguousRemovals.length === 0;
  return {
    repairableExtensions,
    extensionIntents,
    ambiguousRemovals,
    recommendedAction: repairable ? "repair-extensions" : "stage-next-export",
  };
}

interface ImplicitExtensionMatch {
  readonly extension: DeclarativeImplicitExtension;
  readonly signature: string;
  readonly sourcePattern: RegExp;
}

const nonConvergingLoadDiagnosticCodes = new Set(["stuck_statement", "max_rounds_exceeded"]);

function matchImplicitExtension(message: string): ImplicitExtensionMatch | undefined {
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
  const extension = IMPLICIT_EXTENSIONS.find(
    (implicit) => implicit === missingExtension.toLowerCase(),
  );
  if (extension === undefined) return undefined;
  return {
    extension,
    signature: `extension "${extension}"`,
    sourcePattern: new RegExp(`(?:"${extension}"|\\b${extension}\\b)`, "i"),
  };
}

export function declaredExtensions(files: readonly DeclarativeSqlFile[]): ReadonlySet<string> {
  return declaredSqlExtensions(files);
}

function declaredImplicitExtensions(
  files: readonly DeclarativeSqlFile[],
): ReadonlySet<DeclarativeImplicitExtension> {
  const declaredNames = declaredExtensions(files);
  const declared = new Set(IMPLICIT_EXTENSIONS.filter((extension) => declaredNames.has(extension)));
  return declared;
}

function locateSignature(
  files: readonly DeclarativeSqlFile[],
  diagnosticMessage: string,
  pattern: RegExp,
): Pick<DeclarativeLoadCompatibilityFinding, "file" | "line"> {
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
 * declarative tree from loading on pg-delta's isolated desired shadow.
 */
export function classifyDeclarativeLoadCompatibility(opts: {
  readonly manifestPresent: boolean;
  readonly diagnostics: readonly DeclarativeLoadDiagnostic[];
  readonly files: readonly DeclarativeSqlFile[];
}): ReadonlyArray<DeclarativeLoadCompatibilityFinding> {
  if (opts.manifestPresent) return [];

  const declared = declaredImplicitExtensions(opts.files);
  const findings: DeclarativeLoadCompatibilityFinding[] = [];
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

export const extensionDeclaration = (extension: string): string =>
  `CREATE EXTENSION IF NOT EXISTS "${extension}" WITH SCHEMA "extensions";`;

/**
 * Shell family the recovery commands are rendered for. The staged-upgrade
 * recipe contains destructive filesystem operations, so it must be runnable as
 * printed: POSIX shells get `rm -rf`/`mv` with `&&` and backslash
 * continuations; Windows gets single-line PowerShell (`Remove-Item`/`Move-Item`
 * with `;`), which also runs unmodified in Windows Terminal's default shell.
 */
export type ShellPlatform = "posix" | "windows";

export const currentShellPlatform = (): ShellPlatform =>
  process.platform === "win32" ? "windows" : "posix";

export interface StagedExportContext {
  readonly declarativeDir: string;
  readonly schema: ReadonlyArray<string>;
  readonly platform: ShellPlatform;
}

/**
 * Derives the staging directory as a sibling of the declarative directory by
 * suffixing its last path segment. Trailing separators (and `/.` segments) in
 * the configured `declarative_schema_path` are stripped first — appending to
 * `supabase/schemas/` verbatim would nest the staging directory *inside* the
 * active tree, so a later sync would load the staged export recursively and
 * the printed `rm -rf <dir> && mv` adoption command would destroy both copies.
 */
export const resolveStagedDeclarativeDir = (declarativeDir: string): string => {
  const isSeparator = (ch: string | undefined) => ch === "/" || ch === "\\";
  let end = declarativeDir.length;
  while (end > 0) {
    if (isSeparator(declarativeDir[end - 1])) {
      end -= 1;
    } else if (declarativeDir[end - 1] === "." && isSeparator(declarativeDir[end - 2])) {
      end -= 1;
    } else {
      break;
    }
  }
  const trimmed = declarativeDir.slice(0, end);
  return `${trimmed === "" ? declarativeDir : trimmed}-next`;
};

const BARE_SAFE_ARGUMENT = /^[a-zA-Z0-9_./:@%+=,-]+$/;

function shellQuoteArgument(value: string, platform: ShellPlatform): string {
  if (BARE_SAFE_ARGUMENT.test(value)) return value;
  // PowerShell single-quoted strings escape a quote by doubling it; POSIX
  // shells need the classic '"'"' dance.
  return platform === "windows"
    ? `'${value.replaceAll("'", "''")}'`
    : `'${value.replaceAll("'", `'"'"'`)}'`;
}

function schemaArguments(schema: ReadonlyArray<string>, platform: ShellPlatform): string {
  return schema
    .map((name) => ` --schema ${shellQuoteArgument(schemaToCsvField(name), platform)}`)
    .join("");
}

const formatDeclarativeSyncCommand = (
  schema: ReadonlyArray<string>,
  platform: ShellPlatform,
): string =>
  `  supabase db schema declarative sync --no-apply${schemaArguments(schema, platform)} --experimental`;

const adoptionCommand = (
  declarativeDir: string,
  stagedDir: string,
  platform: ShellPlatform,
): string => {
  const dir = shellQuoteArgument(declarativeDir, platform);
  const staged = shellQuoteArgument(stagedDir, platform);
  return platform === "windows"
    ? `  Remove-Item -Recurse -Force -ErrorAction Stop ${dir}; Move-Item ${staged} ${dir}`
    : `  rm -rf ${dir} && mv ${staged} ${dir}`;
};

export function formatStagedExportAdoption({
  declarativeDir,
  schema,
  platform,
}: StagedExportContext): ReadonlyArray<string> {
  const stagedDir = resolveStagedDeclarativeDir(declarativeDir);
  return [
    `Review ${stagedDir}, then adopt it:`,
    adoptionCommand(declarativeDir, stagedDir, platform),
    formatDeclarativeSyncCommand(schema, platform),
  ];
}

/** The staged-upgrade recipe, as a copy-pasteable block of indented shell lines. */
function stagedExportCommands(context: StagedExportContext): ReadonlyArray<string> {
  const stagedDir = resolveStagedDeclarativeDir(context.declarativeDir);
  const staged = shellQuoteArgument(stagedDir, context.platform);
  const schemas = schemaArguments(context.schema, context.platform);
  // Backslash continuation is POSIX-only; keep the generate command on one line
  // for Windows so it runs as printed in PowerShell.
  const generateCommand =
    context.platform === "windows"
      ? [
          `  supabase db schema declarative generate --local --overwrite --output-dir ${staged}${schemas} --experimental`,
        ]
      : [
          "  supabase db schema declarative generate --local --overwrite \\",
          `    --output-dir ${staged}${schemas} --experimental`,
        ];
  return [
    ...generateCommand,
    `  # review ${stagedDir}`,
    adoptionCommand(context.declarativeDir, stagedDir, context.platform),
    formatDeclarativeSyncCommand(context.schema, context.platform),
  ];
}

/**
 * Evidence lines for a plan that succeeded but whose removals reveal the tree is
 * a legacy export (the plan-refuse gate). The load-fail gate builds its own
 * evidence from the shadow-load diagnostics instead.
 */
export function formatDeclarativeGapEvidence(
  gap: DeclarativeCompatibilityGap,
): ReadonlyArray<string> {
  return [
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
}

export interface DeclarativeUpgradeGateText {
  readonly message: string;
  readonly suggestion: string;
}

/**
 * The single template both compatibility gates render. Both mean the same thing
 * ("this declarative tree is a legacy pg-delta export"), so they must read the
 * same; only the evidence block differs. The recovery commands live in
 * `suggestion` so `Output.fail` prints them instead of the generic
 * "rerun with --debug" footer — a deliberate gate is not a crash.
 *
 * Deliberately offers exactly ONE non-interactive recovery: the staged
 * regenerate. Telling a non-interactive user to hand-add an extension
 * declaration is a false trail — on a real legacy tree each declaration only
 * unlocks the next refusal. Interactive flows still offer the repair as an
 * advanced choice.
 */
export function formatDeclarativeUpgradeGate(opts: {
  readonly evidence: ReadonlyArray<string>;
  readonly context: StagedExportContext;
}): DeclarativeUpgradeGateText {
  const { declarativeDir } = opts.context;
  return {
    message: [
      `This ${declarativeDir} tree looks like a legacy pg-delta export.`,
      "pg-delta next only loads extensions the tree declares; legacy exports omitted",
      "platform extensions and extension-managed objects like cron jobs.",
      ...(opts.evidence.length > 0 ? ["", ...opts.evidence.map((line) => `  ${line}`)] : []),
      "",
      "Do not apply a sync generated from this tree — it can drop extensions or unschedule jobs.",
    ].join("\n"),
    suggestion: [
      `Upgrade without changing the active ${declarativeDir} tree:`,
      "",
      ...stagedExportCommands(opts.context),
    ].join("\n"),
  };
}
