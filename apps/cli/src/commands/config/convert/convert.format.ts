import type { CliConfigConvertError, MovedTomlComment } from "@supabase/config/internal";

export const CONFIG_JSONC_MIN_CLI_VERSION = "3.1.0";

export function dryRunMessage(vscodeWouldUpdate: boolean): string {
  return vscodeWouldUpdate
    ? "Dry run: would write supabase/config.jsonc, delete supabase/config.toml, and add the schema domain to .vscode/settings.json."
    : "Dry run: would write supabase/config.jsonc and delete supabase/config.toml.";
}

export function alreadyConvertedMessage(jsonFile: string): string {
  return `supabase/${jsonFile} is already the project config; nothing to convert.`;
}

export function jsonPrecedenceMessage(jsonFile: string): string {
  return `supabase/config.toml is ignored because supabase/${jsonFile} takes precedence. Delete supabase/${jsonFile} first to convert config.toml again.`;
}

export const CONVERTED_MESSAGE = "Converted supabase/config.toml to supabase/config.jsonc.";

export const REMOVED_MESSAGE =
  "Removed supabase/config.toml; supabase/config.jsonc is now the project config.";

export const MIN_VERSION_WARNING = `Older Supabase CLIs (before ${CONFIG_JSONC_MIN_CLI_VERSION}) ignore config.jsonc and run with defaults; some commands (init, functions new) create a new config.toml that newer CLIs then ignore. Upgrade every machine and CI job that runs supabase for this project. To undo, run: git restore supabase/config.toml && rm supabase/config.jsonc`;

const TRUSTED_DOMAIN = "https://supabase.com/schemas/";

export const trustedDomainMessage = `Added ${TRUSTED_DOMAIN} to json.schemaDownload.trustedDomains in .vscode/settings.json.`;

export function vscodeFailureWarning(detail: string): string {
  return `Could not update .vscode/settings.json: ${detail}. Add "${TRUSTED_DOMAIN}": true under "json.schemaDownload.trustedDomains" to trust the config schema.`;
}

export function refusalMessage(error: CliConfigConvertError): string {
  const location = error.sourceLine === undefined ? "" : ` at line ${error.sourceLine}`;
  return `cannot convert supabase/config.toml${location}: ${error.detail}. supabase/config.toml was not changed.`;
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

export function tomlRemovalFailureMessage(cause: string): string {
  return `Wrote supabase/config.jsonc but could not remove supabase/config.toml: ${cause}. config.jsonc takes precedence; delete config.toml yourself.`;
}

function movedCommentsWarning(moved: ReadonlyArray<MovedTomlComment>): ReadonlyArray<string> {
  if (moved.length === 0) {
    return [];
  }
  return [
    `Moved ${moved.length} comment(s) that were inside multi-line values to the line above their key:`,
    ...moved.map(
      (comment) => `  line ${comment.line} → ${comment.anchor.join(".")}: ${comment.text}`,
    ),
  ];
}

export function convertWarnings(input: {
  readonly moved: ReadonlyArray<MovedTomlComment>;
  readonly vscodeFailure: string | undefined;
}): ReadonlyArray<string> {
  return [
    ...movedCommentsWarning(input.moved),
    MIN_VERSION_WARNING,
    ...(input.vscodeFailure === undefined ? [] : [vscodeFailureWarning(input.vscodeFailure)]),
  ];
}

interface PayloadInput {
  readonly schema: string;
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
    removed: "supabase/config.toml",
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
    would_remove: "supabase/config.toml",
    would_update_vscode_settings: input.vscodeWouldUpdate,
    content: input.content,
  };
}

export function alreadyConvertedPayload(jsonFile: string) {
  return { converted: false, path: `supabase/${jsonFile}` };
}
