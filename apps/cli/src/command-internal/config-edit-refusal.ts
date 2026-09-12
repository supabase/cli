import type { ConfigEditRefusalReason } from "@supabase/config/internal";

/**
 * Human-readable phrase for a `ConfigEditRefusal.reason` — the raw enum token
 * (`duplicate_table_header`, …) never appears in a user-facing message, only prose.
 */
export function configEditRefusalPhrase(reason: ConfigEditRefusalReason): string {
  switch (reason) {
    case "duplicate_table_header":
      return "a duplicate table header";
    case "array_of_tables_on_path":
      return "an array of tables on this path";
    case "inline_table_on_path":
      return "an inline table on this path";
    case "env_reference_target":
      return "an existing env() reference at this path";
    case "verification_mismatch":
      return "a verification mismatch after editing";
    case "parse_error":
      return "a parse error";
  }
}

/**
 * One remediation sentence per `ConfigEditRefusal.reason`, naming `command` where the
 * limitation is the command's rather than the document's. `verification_mismatch` and
 * `parse_error` both mean the editor misjudged the document, not something the user can fix
 * by hand.
 */
export function configEditRefusalRemediation(
  reason: ConfigEditRefusalReason,
  command: string,
): string {
  switch (reason) {
    case "duplicate_table_header":
      return "Merge the duplicate table headers into one, then rerun.";
    case "inline_table_on_path":
      return "Rewrite it as a standard [table] section, then rerun.";
    case "array_of_tables_on_path":
      return `${command} does not support writing through an array of tables ([[...]]); restructure it by hand, then rerun.`;
    case "env_reference_target":
      return "Replace the env(...) reference with a literal value, then rerun.";
    case "verification_mismatch":
    case "parse_error":
      return "This is a CLI bug; nothing was written. Please report it.";
  }
}
