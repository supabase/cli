import type { MovedJsoncComment } from "@supabase/config/internal";

import { shellQuoteArgument, type ShellPlatform } from "../../../command-internal/shell-quote.ts";
import {
  CONVERT_REASONS,
  type ConvertReason,
} from "../../../telemetry/command-telemetry-attributes.ts";
import { PLAIN_REPORT_STYLE, type ReportStyle } from "./convert.format.ts";

export const REASON_WITHOUT_TOML_TARGET_MESSAGE =
  "--reason only applies with --to toml. Add --to toml, or drop --reason.";

export const ALREADY_TOML_MESSAGE = "supabase/config.toml is already TOML. Nothing to convert.";

export const REASON_PROMPT = "What made you switch back to TOML? (optional, anonymous)";

const SKIP_REASON_VALUE = "skip";

const REASON_LABELS: Readonly<Record<ConvertReason, string>> = {
  editor: "My editor works better with TOML",
  "third-party-tool": "A tool I use only reads TOML",
  "older-cli": "Some machines run an older Supabase CLI",
  "ci-or-deploy": "My CI or deploy setup needs TOML",
  "ai-agent": "An AI agent works better with TOML",
  preference: "I prefer TOML",
  other: "Something else",
};

export const REASON_OPTIONS: ReadonlyArray<{ readonly value: string; readonly label: string }> = [
  { value: SKIP_REASON_VALUE, label: "Skip" },
  ...CONVERT_REASONS.map((value) => ({ value, label: REASON_LABELS[value] })),
];

const anchorLabel = (anchor: ReadonlyArray<string>): string =>
  anchor.length === 0 ? "top level" : anchor.join(".");

export function parseReason(value: string): ConvertReason | undefined {
  return CONVERT_REASONS.find((reason) => reason === value);
}

export function tomlExistsMessage(jsonFile: string): string {
  return `supabase/config.toml exists, but supabase/${jsonFile} takes precedence, so converting would overwrite it. Move or delete supabase/config.toml, then rerun the command. Nothing was converted.`;
}

export const convertedToTomlMessage = (jsonFile: string) =>
  `Converted supabase/${jsonFile} to supabase/config.toml.`;

export function dryRunToTomlMessage(jsonFile: string, backup: string): string {
  return `Dry run: would write supabase/config.toml and move supabase/${jsonFile} to ${backup}.`;
}

/** The command that restores the JSON config from `backup`, with paths prefixed by `root`. */
export function undoToTomlCommand(
  root: string,
  backup: string,
  jsonFile: string,
  platform: ShellPlatform,
): string {
  const at = (file: string) => shellQuoteArgument(root === "" ? file : `${root}/${file}`, platform);
  return platform === "windows"
    ? `Move-Item -LiteralPath ${at(backup)} -Destination ${at(`supabase/${jsonFile}`)}; if ($?) { Remove-Item -LiteralPath ${at("supabase/config.toml")} }`
    : `mv -- ${at(backup)} ${at(`supabase/${jsonFile}`)} && rm -- ${at("supabase/config.toml")}`;
}

export const jsonNotUtf8Message = (jsonFile: string) =>
  `cannot convert supabase/${jsonFile}: it is not valid UTF-8. Re-save it as UTF-8 and rerun the command. supabase/${jsonFile} was not changed.`;

export const jsonSymlinkMessage = (jsonFile: string) =>
  `cannot convert supabase/${jsonFile}: it is a symbolic link, and converting it would leave the file it points to behind. Replace the link with the file itself, then rerun the command. supabase/${jsonFile} was not changed.`;

export const tomlSymlinkMessage = (jsonFile: string) =>
  `supabase/config.toml is a symbolic link to a file that does not exist. Remove it, then rerun the command. supabase/${jsonFile} was not changed.`;

export const tomlWriteFailureMessage = (jsonFile: string, cause: string) =>
  `${cause}. supabase/${jsonFile} was not changed.`;

export const tomlAppearedMessage = (jsonFile: string) =>
  `supabase/config.toml appeared while config convert was running, so it was left as is and supabase/${jsonFile} is unchanged. Check which file you want to keep; another conversion may have finished first.`;

export const tomlRemovedNote = (jsonFile: string) =>
  `Removed supabase/config.toml and kept supabase/${jsonFile}; rerun the command to convert the current file.`;

export const tomlChangedNote = (jsonFile: string) =>
  `supabase/config.toml changed after config convert wrote it, so it was left as is alongside supabase/${jsonFile}; supabase/${jsonFile} takes precedence, so check which file you want to keep.`;

export const tomlRemovalFailureNote = (jsonFile: string, cause: string) =>
  `Could not remove the new supabase/config.toml (${cause}); supabase/${jsonFile} takes precedence over it, so delete it before rerunning the command.`;

export const toTomlBackupCheckFailureMessage = (jsonFile: string, cause: string) =>
  `Could not check for an existing backup of supabase/${jsonFile}: ${cause}. supabase/${jsonFile} was not changed.`;

export const toTomlBackupFailureMessage = (
  jsonFile: string,
  backup: string,
  cause: string,
  note: string,
) => `Could not move supabase/${jsonFile} to ${backup}: ${cause}. ${note}`;

export const toTomlBackupUnverifiedMessage = (
  jsonFile: string,
  backup: string,
  cause: string,
  undo: string,
) =>
  `Converted supabase/${jsonFile} to supabase/config.toml and moved it to ${backup}, but could not read the backup to confirm ${jsonFile} did not change during the run: ${cause}. Compare ${backup} with supabase/config.toml; to undo, run: ${undo}`;

export const jsonChangedMessage = (jsonFile: string, backup: string, undo: string) =>
  `supabase/${jsonFile} changed while config convert was running, so supabase/config.toml holds the earlier version. The latest ${jsonFile} is at ${backup}; to restore it, run: ${undo}, then rerun the command.`;

export function toTomlWarnings(input: {
  readonly dryRun: boolean;
  readonly undo: string;
  readonly moved: ReadonlyArray<MovedJsoncComment>;
}): ReadonlyArray<string> {
  const { moved } = input;
  return [
    ...(moved.length === 0
      ? []
      : [
          `Moved ${moved.length} comment(s) that could not stay in place to a nearby line in supabase/config.toml:`,
          ...moved.map(
            (comment) => `  line ${comment.line} → ${anchorLabel(comment.anchor)}: ${comment.text}`,
          ),
        ]),
    `${input.dryRun ? "To undo after converting" : "To undo"}, run: ${input.undo}`,
  ];
}

/** Renders the text-mode summary of a conversion to TOML, or of the one `--dry-run` previews. */
export function toTomlReport(
  input: {
    readonly dryRun: boolean;
    readonly jsonFile: string;
    readonly backup: string;
    readonly undo: string;
    readonly moved: ReadonlyArray<MovedJsoncComment>;
  },
  style: ReportStyle = PLAIN_REPORT_STYLE,
): string {
  const { bold, dim, green, blue, code } = style;
  const verb = (planned: string, done: string) => (input.dryRun ? planned : done);
  const change = (marker: string, planned: string, done: string, target: string) =>
    `    ${marker} ${verb(planned, done).padEnd(input.dryRun ? 6 : 7)}  ${target}`;
  const lines: Array<string> = input.dryRun
    ? [
        `${green("✓")} ${bold("Config conversion preview")}`,
        `  ${dim("Dry run. No files were changed.")}`,
      ]
    : [`${green("✓")} ${bold(`Converted supabase/${input.jsonFile} to supabase/config.toml`)}`];

  lines.push(
    "",
    `  ${bold(verb("Planned changes", "Changes"))}`,
    change(green("+"), "Create", "Created", code("supabase/config.toml")),
    change(
      blue(">"),
      "Move",
      "Moved",
      `${code(`supabase/${input.jsonFile}`)} ${dim("to")} ${code(input.backup)}`,
    ),
  );

  if (input.moved.length > 0) {
    const count = input.moved.length;
    lines.push(
      "",
      `  ${blue("ℹ")} ${bold(`${count} ${count === 1 ? "comment" : "comments"} relocated`)}`,
      `    ${dim("Comments that cannot sit at their place in TOML move to a nearby line.")}`,
      ...input.moved.map(
        (comment) =>
          `    line ${comment.line} → ${code(anchorLabel(comment.anchor))}  ${dim(comment.text)}`,
      ),
    );
  }

  lines.push(
    "",
    `  ${dim(verb("To undo after converting:", "To undo:"))}`,
    `    ${code(input.undo)}`,
    "",
  );
  return lines.join("\n");
}

interface ToTomlPayloadInput {
  readonly schema: string;
  readonly backup: string;
  readonly moved: ReadonlyArray<MovedJsoncComment>;
  readonly warnings: ReadonlyArray<string>;
}

function toTomlPayloadBase(input: ToTomlPayloadInput) {
  return {
    path: "supabase/config.toml",
    target: "toml",
    schema: input.schema,
    moved_comments: input.moved.map((comment) => ({
      line: comment.line,
      key: comment.anchor.join("."),
      text: comment.text,
    })),
    warnings: input.warnings,
  };
}

export function convertToTomlPayload(input: ToTomlPayloadInput) {
  return { ...toTomlPayloadBase(input), converted: true, backup: input.backup };
}

export function dryRunToTomlPayload(input: ToTomlPayloadInput & { readonly content: string }) {
  return {
    ...toTomlPayloadBase(input),
    converted: false,
    dry_run: true,
    would_backup: input.backup,
    content: input.content,
  };
}

export function alreadyTomlPayload() {
  return { converted: false, path: "supabase/config.toml", format: "toml" };
}
