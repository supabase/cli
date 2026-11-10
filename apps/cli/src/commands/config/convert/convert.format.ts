import type { CliConfigConvertError, MovedTomlComment } from "@supabase/config/internal";

import { shellQuoteArgument, type ShellPlatform } from "../../../command-internal/shell-quote.ts";

export const CONFIG_JSONC_MIN_CLI_VERSION = "3.1.0";

export function dryRunMessage(vscodeWouldUpdate: boolean, backup: string): string {
  return vscodeWouldUpdate
    ? `Dry run: would write supabase/config.jsonc, move supabase/config.toml to ${backup}, and add the schema domain to .vscode/settings.json.`
    : `Dry run: would write supabase/config.jsonc and move supabase/config.toml to ${backup}.`;
}

export function alreadyConvertedMessage(jsonFile: string): string {
  return `supabase/${jsonFile} is already the project config; nothing to convert.`;
}

export function jsonPrecedenceMessage(jsonFile: string): string {
  return `supabase/config.toml is ignored because supabase/${jsonFile} takes precedence. Delete supabase/${jsonFile} first to convert config.toml again.`;
}

export const CONVERTED_MESSAGE = "Converted supabase/config.toml to supabase/config.jsonc.";

/** The command that restores config.toml from `backup`, with paths prefixed by `root` (the project root relative to the cwd). */
export function undoCommand(root: string, backup: string, platform: ShellPlatform): string {
  const at = (file: string) => shellQuoteArgument(root === "" ? file : `${root}/${file}`, platform);
  return `mv ${at(backup)} ${at("supabase/config.toml")} && rm ${at("supabase/config.jsonc")}`;
}

const COMPATIBILITY_LINES = [
  `Supabase CLI versions before ${CONFIG_JSONC_MIN_CLI_VERSION} ignore config.jsonc and run with defaults.`,
  "Upgrade the Supabase CLI on every machine and CI job that uses this project.",
] as const;

export function minVersionWarning(dryRun: boolean, undo: string): string {
  return `${COMPATIBILITY_LINES.join(" ")} ${dryRun ? "To undo after converting" : "To undo"}, run: ${undo}`;
}

const TRUSTED_DOMAIN = "https://supabase.com/schemas/";

const VSCODE_MANUAL_STEP = `Add "${TRUSTED_DOMAIN}": true under "json.schemaDownload.trustedDomains" to trust the config schema.`;

function vscodeFailureWarning(detail: string): string {
  return `Could not update .vscode/settings.json: ${detail}. ${VSCODE_MANUAL_STEP}`;
}

export function refusalMessage(error: CliConfigConvertError): string {
  const location = error.sourceLine === undefined ? "" : ` at line ${error.sourceLine}`;
  return `cannot convert supabase/config.toml${location}: ${error.detail}. supabase/config.toml was not changed.`;
}

export const NOT_UTF8_MESSAGE =
  "cannot convert supabase/config.toml: it is not valid UTF-8, which TOML requires. Re-save it as UTF-8 and rerun the command. supabase/config.toml was not changed.";

export const TOML_SYMLINK_MESSAGE =
  "cannot convert supabase/config.toml: it is a symbolic link, and converting it would leave the file it points to behind. Replace the link with the file itself, then rerun the command. supabase/config.toml was not changed.";

export const JSONC_SYMLINK_MESSAGE =
  "supabase/config.jsonc is a symbolic link to a file that does not exist. Remove it, then rerun the command. supabase/config.toml was not changed.";

export function writeFailureMessage(cause: string): string {
  return `${cause}. supabase/config.toml was not changed.`;
}

export const JSONC_APPEARED_MESSAGE =
  "supabase/config.jsonc appeared while config convert was running, so it was left as is and supabase/config.toml is unchanged. Check which file you want to keep; another conversion may have finished first.";

export const JSONC_REMOVED_NOTE =
  "Removed supabase/config.jsonc and kept supabase/config.toml; rerun the command to convert the current file.";

export const JSONC_CHANGED_NOTE =
  "supabase/config.jsonc changed after config convert wrote it, so it was left as is alongside supabase/config.toml; supabase/config.jsonc takes precedence, so check which file you want to keep.";

export function jsoncRemovalFailureNote(cause: string): string {
  return `Could not remove the new supabase/config.jsonc (${cause}); it takes precedence over supabase/config.toml, so delete it before rerunning the command.`;
}

export function backupFailureMessage(backup: string, cause: string, note: string): string {
  return `Could not move supabase/config.toml to ${backup}: ${cause}. ${note}`;
}

export function tomlChangedMessage(backup: string, undo: string): string {
  return `supabase/config.toml changed while config convert was running, so supabase/config.jsonc holds the earlier version. The latest config.toml is at ${backup}; to restore it, run: ${undo}, then rerun the command.`;
}

function movedCommentsWarning(moved: ReadonlyArray<MovedTomlComment>): ReadonlyArray<string> {
  if (moved.length === 0) {
    return [];
  }
  return [
    `Moved ${moved.length} comment(s) that were inside nested arrays or inline tables to the line above their key:`,
    ...moved.map(
      (comment) => `  line ${comment.line} → ${comment.anchor.join(".")}: ${comment.text}`,
    ),
  ];
}

export function convertWarnings(input: {
  readonly dryRun: boolean;
  readonly undo: string;
  readonly moved: ReadonlyArray<MovedTomlComment>;
  readonly vscodeFailure: string | undefined;
}): ReadonlyArray<string> {
  return [
    ...movedCommentsWarning(input.moved),
    minVersionWarning(input.dryRun, input.undo),
    ...(input.vscodeFailure === undefined ? [] : [vscodeFailureWarning(input.vscodeFailure)]),
  ];
}

/** ANSI styling applied to the text report; the handler passes stream-gated colours. */
export interface ReportStyle {
  readonly bold: (text: string) => string;
  readonly dim: (text: string) => string;
  readonly green: (text: string) => string;
  readonly yellow: (text: string) => string;
  readonly blue: (text: string) => string;
  readonly code: (text: string) => string;
}

const plain = (text: string) => text;

export const PLAIN_REPORT_STYLE: ReportStyle = {
  bold: plain,
  dim: plain,
  green: plain,
  yellow: plain,
  blue: plain,
  code: plain,
};

/** Renders the text-mode summary of a conversion, or of the conversion `--dry-run` previews. */
export function convertReport(
  input: {
    readonly dryRun: boolean;
    readonly backup: string;
    readonly undo: string;
    readonly moved: ReadonlyArray<MovedTomlComment>;
    readonly vscodeUpdated: boolean;
    readonly vscodeFailure: string | undefined;
  },
  style: ReportStyle = PLAIN_REPORT_STYLE,
): string {
  const { bold, dim, green, yellow, blue, code } = style;
  const verb = (planned: string, done: string) => (input.dryRun ? planned : done);
  const change = (marker: string, planned: string, done: string, target: string) =>
    `    ${marker} ${verb(planned, done).padEnd(input.dryRun ? 6 : 7)}  ${target}`;
  const lines: Array<string> = input.dryRun
    ? [
        `${green("✓")} ${bold("Config conversion preview")}`,
        `  ${dim("Dry run. No files were changed.")}`,
      ]
    : [`${green("✓")} ${bold("Converted supabase/config.toml to supabase/config.jsonc")}`];

  lines.push(
    "",
    `  ${bold(verb("Planned changes", "Changes"))}`,
    change(green("+"), "Create", "Created", code("supabase/config.jsonc")),
    change(
      blue(">"),
      "Move",
      "Moved",
      `${code("supabase/config.toml")} ${dim("to")} ${code(input.backup)}`,
    ),
  );
  if (input.vscodeUpdated) {
    lines.push(
      change(
        yellow("~"),
        "Update",
        "Updated",
        `${code(".vscode/settings.json")} ${dim(`(trusts ${TRUSTED_DOMAIN})`)}`,
      ),
    );
  }

  if (input.moved.length > 0) {
    const count = input.moved.length;
    lines.push(
      "",
      `  ${blue("ℹ")} ${bold(`${count} ${count === 1 ? "comment" : "comments"} relocated`)}`,
      `    ${dim("Comments inside nested arrays or inline tables move to the line above their key.")}`,
      ...input.moved.map(
        (comment) =>
          `    line ${comment.line} → ${code(comment.anchor.join("."))}  ${dim(comment.text)}`,
      ),
    );
  }

  if (input.vscodeFailure !== undefined) {
    lines.push(
      "",
      `  ${yellow("⚠")} ${bold("Could not update .vscode/settings.json")}`,
      `    ${input.vscodeFailure}.`,
      `    ${VSCODE_MANUAL_STEP}`,
    );
  }

  lines.push(
    "",
    `  ${yellow("⚠")} ${bold("Compatibility")}`,
    ...COMPATIBILITY_LINES.map((line) => `    ${line}`),
    "",
    `  ${dim(verb("To undo after converting:", "To undo:"))}`,
    `    ${code(input.undo)}`,
    "",
  );
  return lines.join("\n");
}

interface PayloadInput {
  readonly schema: string;
  readonly backup: string;
  readonly moved: ReadonlyArray<MovedTomlComment>;
  readonly warnings: ReadonlyArray<string>;
}

function payloadBase(input: PayloadInput) {
  return {
    path: "supabase/config.jsonc",
    schema: input.schema,
    moved_comments: input.moved.map((comment) => ({
      line: comment.line,
      key: comment.anchor.join("."),
      text: comment.text,
    })),
    min_cli_version: CONFIG_JSONC_MIN_CLI_VERSION,
    warnings: input.warnings,
  };
}

export function convertPayload(input: PayloadInput & { readonly vscodeUpdated: boolean }) {
  return {
    ...payloadBase(input),
    converted: true,
    backup: input.backup,
    vscode_settings_updated: input.vscodeUpdated,
  };
}

export function dryRunPayload(
  input: PayloadInput & { readonly vscodeWouldUpdate: boolean; readonly content: string },
) {
  return {
    ...payloadBase(input),
    converted: false,
    dry_run: true,
    would_backup: input.backup,
    would_update_vscode_settings: input.vscodeWouldUpdate,
    content: input.content,
  };
}

export function alreadyConvertedPayload(jsonFile: string) {
  return { converted: false, path: `supabase/${jsonFile}` };
}
