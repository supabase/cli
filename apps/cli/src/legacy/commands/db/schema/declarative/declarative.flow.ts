import type { LegacyPgDeltaImplementation } from "../../../../shared/legacy-pgdelta-next-flag.ts";
import { legacySchemaToCsvField } from "../../../../shared/legacy-schema-flags.ts";
import {
  legacyDeclaredSqlExtensions,
  legacyMaskSqlComments,
} from "../../shared/legacy-pgdelta-declarative-shadow-prep.ts";
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
  /**
   * Extension-managed object removals (cron jobs, pgmq queues) whose owning
   * extension the tree does not declare. A removal whose owner IS declared is an
   * intentional delete on a maintained tree and never appears here — it flows
   * through the destructive-changes warning instead.
   */
  readonly extensionIntents: LegacyPgDeltaRemovalSummary["extensionIntents"];
  readonly ambiguousRemovals: ReadonlyArray<string>;
  readonly recommendedAction: LegacyDeclarativeCompatibilityAction;
}

/**
 * The destructive-changes warning line for an extension-managed object removal
 * (`pg_cron job <name>`, `pgmq queue <name>`); also the evidence form the
 * plan-refuse gate enumerates.
 */
export const legacyFormatExtensionIntentRemoval = (
  intent: LegacyPgDeltaRemovalSummary["extensionIntents"][number],
): string => `${intent.extension} ${intent.intentKind} ${intent.key}`;

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

/**
 * Classifies manifest-less pg-delta next removals without performing any I/O.
 *
 * Only a missing `CREATE EXTENSION` declaration is legacy-export evidence: legacy
 * exports omitted platform extensions wholesale, and a tree that omits `pg_cron`
 * also plans the pg_cron *extension* removal, so the gate still fires for it and
 * still enumerates the jobs at risk. An extension-managed object removal whose
 * owner the tree declares (`declaredExtensions`, from the loaded SQL files) is an
 * intentional delete or rename on a maintained tree and must not trip the gate
 * (CLI-2282); the caller surfaces it through the destructive-changes warning.
 */
export function legacyClassifyDeclarativeCompatibilityGap(opts: {
  readonly implementation: LegacyPgDeltaImplementation;
  readonly manifestPresent: boolean;
  readonly removals: LegacyPgDeltaRemovalSummary;
  /** Lower-cased extension names the declarative tree declares. */
  readonly declaredExtensions: ReadonlySet<string>;
}): LegacyDeclarativeCompatibilityGap {
  if (opts.implementation !== "next" || opts.manifestPresent) return emptyCompatibilityGap();

  const extensions = [...new Set(opts.removals.extensions)].sort();
  const repairableExtensions = extensions.filter((extension) =>
    LEGACY_IMPLICIT_EXTENSIONS.some((implicit) => implicit === extension),
  );
  const ambiguousRemovals = extensions.filter(
    (extension) => !LEGACY_IMPLICIT_EXTENSIONS.some((implicit) => implicit === extension),
  );
  const extensionIntents = opts.removals.extensionIntents.filter(
    (intent) => !opts.declaredExtensions.has(intent.extension.toLowerCase()),
  );

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

export function legacyDeclaredExtensions(
  files: readonly LegacyDeclarativeSqlFile[],
): ReadonlySet<string> {
  return legacyDeclaredSqlExtensions(files);
}

function declaredImplicitExtensions(
  files: readonly LegacyDeclarativeSqlFile[],
): ReadonlySet<LegacyDeclarativeImplicitExtension> {
  const declaredNames = legacyDeclaredExtensions(files);
  const declared = new Set(
    LEGACY_IMPLICIT_EXTENSIONS.filter((extension) => declaredNames.has(extension)),
  );
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
    const match = pattern.exec(legacyMaskSqlComments(file.sql));
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

/**
 * Shell family the recovery commands are rendered for. The staged-upgrade
 * recipe contains destructive filesystem operations, so it must be runnable as
 * printed: POSIX shells get `rm -rf`/`mv` with `&&` and backslash
 * continuations; Windows gets single-line PowerShell (`Remove-Item`/`Move-Item`
 * with `;`), which also runs unmodified in Windows Terminal's default shell.
 */
export type LegacyShellPlatform = "posix" | "windows";

export const legacyCurrentShellPlatform = (): LegacyShellPlatform =>
  process.platform === "win32" ? "windows" : "posix";

export interface LegacyStagedExportContext {
  readonly declarativeDir: string;
  readonly schema: ReadonlyArray<string>;
  readonly platform: LegacyShellPlatform;
}

/**
 * Derives the staging directory as a sibling of the declarative directory by
 * suffixing its last path segment. Trailing separators (and `/.` segments) in
 * the configured `declarative_schema_path` are stripped first — appending to
 * `supabase/schemas/` verbatim would nest the staging directory *inside* the
 * active tree, so a later sync would load the staged export recursively and
 * the printed `rm -rf <dir> && mv` adoption command would destroy both copies.
 */
export const legacyResolveStagedDeclarativeDir = (declarativeDir: string): string => {
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

function shellQuoteArgument(value: string, platform: LegacyShellPlatform): string {
  if (BARE_SAFE_ARGUMENT.test(value)) return value;
  // PowerShell single-quoted strings escape a quote by doubling it; POSIX
  // shells need the classic '"'"' dance.
  return platform === "windows"
    ? `'${value.replaceAll("'", "''")}'`
    : `'${value.replaceAll("'", `'"'"'`)}'`;
}

function schemaArguments(schema: ReadonlyArray<string>, platform: LegacyShellPlatform): string {
  return schema
    .map((name) => ` --schema ${shellQuoteArgument(legacySchemaToCsvField(name), platform)}`)
    .join("");
}

export const legacyFormatDeclarativeSyncCommand = (
  schema: ReadonlyArray<string>,
  platform: LegacyShellPlatform,
  options: { readonly allowRemovals?: boolean } = {},
): string =>
  `  supabase db schema declarative sync --no-apply${options.allowRemovals === true ? " --allow-removals" : ""}${schemaArguments(schema, platform)} --experimental`;

const adoptionCommand = (
  declarativeDir: string,
  stagedDir: string,
  platform: LegacyShellPlatform,
): string => {
  const dir = shellQuoteArgument(declarativeDir, platform);
  const staged = shellQuoteArgument(stagedDir, platform);
  return platform === "windows"
    ? `  Remove-Item -Recurse -Force -ErrorAction Stop ${dir}; Move-Item ${staged} ${dir}`
    : `  rm -rf ${dir} && mv ${staged} ${dir}`;
};

export function legacyFormatStagedExportAdoption({
  declarativeDir,
  schema,
  platform,
}: LegacyStagedExportContext): ReadonlyArray<string> {
  const stagedDir = legacyResolveStagedDeclarativeDir(declarativeDir);
  return [
    `Review ${stagedDir}, then adopt it:`,
    adoptionCommand(declarativeDir, stagedDir, platform),
    legacyFormatDeclarativeSyncCommand(schema, platform),
  ];
}

/** The staged-upgrade recipe, as a copy-pasteable block of indented shell lines. */
function stagedExportCommands(context: LegacyStagedExportContext): ReadonlyArray<string> {
  const stagedDir = legacyResolveStagedDeclarativeDir(context.declarativeDir);
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
    legacyFormatDeclarativeSyncCommand(context.schema, context.platform),
  ];
}

/**
 * Evidence lines for a plan that succeeded but whose removals reveal the tree is
 * a legacy export (the plan-refuse gate). The load-fail gate builds its own
 * evidence from the shadow-load diagnostics instead.
 */
export function legacyFormatDeclarativeGapEvidence(
  gap: LegacyDeclarativeCompatibilityGap,
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
            .map(legacyFormatExtensionIntentRemoval)
            .join(", ")}`,
        ]
      : []),
  ];
}

export interface LegacyDeclarativeUpgradeGateText {
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
 * Deliberately offers exactly ONE non-interactive recovery for the legacy-tree
 * reading: the staged regenerate. Telling a non-interactive user to hand-add an
 * extension declaration is a false trail — on a real legacy tree each
 * declaration only unlocks the next refusal. Interactive flows still offer the
 * repair as an advanced choice.
 *
 * The plan-refuse gate additionally names `--allow-removals` (`offerAllowRemovals`)
 * for the other reading — the removals are intentional — which downgrades the
 * gate to the destructive-changes warning. The load-fail gate cannot offer it:
 * a tree that does not load has nothing to sync.
 */
export function legacyFormatDeclarativeUpgradeGate(opts: {
  readonly evidence: ReadonlyArray<string>;
  readonly context: LegacyStagedExportContext;
  readonly offerAllowRemovals?: boolean;
}): LegacyDeclarativeUpgradeGateText {
  const { declarativeDir, schema, platform } = opts.context;
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
      ...(opts.offerAllowRemovals === true
        ? [
            "",
            "If these removals are intentional, keep the tree and rerun with --allow-removals to review them as destructive changes:",
            "",
            legacyFormatDeclarativeSyncCommand(schema, platform, { allowRemovals: true }),
          ]
        : []),
    ].join("\n"),
  };
}
