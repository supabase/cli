import { type V1GetHostnameConfigOutput } from "@supabase/api/effect";

/**
 * The custom-hostname response shape. The Management API returns the same
 * structure for get / create / reverify / activate, so a single type covers
 * every status formatter.
 */
export type LegacyHostnameResponse = typeof V1GetHostnameConfigOutput.Type;

type LegacyHostnameSsl = LegacyHostnameResponse["data"]["result"]["ssl"];

type LegacyHostnameStatus = Exclude<LegacyHostnameResponse["status"], undefined>;

function getHostnameStatus(response: LegacyHostnameResponse): LegacyHostnameStatus | undefined {
  if (response.status !== undefined) {
    return response.status;
  }
  const result = response.data.result;
  if (
    result.status === "pending" ||
    result.ssl.status === "initializing" ||
    result.ssl.validation_records !== undefined ||
    result.ownership_verification !== undefined
  ) {
    return "2_initiated";
  }
  return undefined;
}

/**
 * Byte-for-byte port of Go's `hostnames.PrintStatus`
 * (`apps/cli-go/internal/hostnames/common.go:24-59`). Returns the exact string
 * the Go CLI writes to stderr — mind the trailing-newline difference between
 * `Fprintln` (adds `\n`) and `Fprintf` (does not).
 */
export function formatHostnameStatus(response: LegacyHostnameResponse): string {
  switch (getHostnameStatus(response)) {
    case "5_services_reconfigured":
      // Fprintf — no trailing newline.
      return `Custom hostname setup completed. Project is now accessible at ${response.custom_hostname}.`;
    case "4_origin_setup_completed":
      // Fprintf raw string literal — no trailing newline.
      return `Custom hostname configuration complete, and ready for activation.

Please ensure that your custom domain is set up as a CNAME record to your Supabase subdomain:
${response.custom_hostname} CNAME -> ${response.data.result.custom_origin_server}`;
    case "3_challenge_verified":
    case "2_initiated": {
      const ssl = response.data.result.ssl;
      if (ssl.status === "initializing") {
        // Fprintln — trailing newline.
        return "Custom hostname setup is being initialized; please request re-verification in a few seconds.\n";
      }
      const validationErrors = ssl.validation_errors;
      if (validationErrors !== undefined && validationErrors.length > 0) {
        const errorMessages: string[] = [];
        for (const valError of validationErrors) {
          if (valError.message.includes("caa_error")) {
            // Fprintln — trailing newline; Go returns immediately.
            return 'CAA mismatch; please remove any existing CAA records on your domain, or add one for "digicert.com"\n';
          }
          errorMessages.push(valError.message);
        }
        // Fprintf with explicit trailing `\n`.
        return `SSL validation errors: \n\t- ${errorMessages.join("\n\t- ")}\n`;
      }
      const validationRecords = ssl.validation_records ?? [];
      if (validationRecords.length !== 1) {
        // Fprintf — no trailing newline. Go formats the ssl struct with `%+v`;
        // not byte-reproducible (see formatSslStructDump).
        return `expected a single SSL verification record, received: ${formatSslStructDump(ssl)}`;
      }
      // Fprintln on the two-line heading, then a tab-indented record (Fprintf, no newline).
      let out =
        "Custom hostname verification in-progress; please configure the appropriate DNS entries and request re-verification.\nRequired outstanding validation records:\n";
      const rec = validationRecords[0];
      if (rec !== undefined && rec.txt_name !== "") {
        out += `\t${rec.txt_name} TXT -> ${rec.txt_value}`;
      }
      return out;
    }
    case "1_not_started":
      // Fprintln — trailing newline.
      return "Custom hostname configuration not started.\n";
    default:
      // Go's switch has no default arm — nothing is written.
      return "";
  }
}

/**
 * Approximates Go's `fmt.Sprintf("%+v", ssl)` for the degenerate
 * "validation_records != 1" branch. The Go output embeds a pointer address for
 * the `ValidationErrors` field and is therefore not byte-reproducible; this
 * dump is deterministic and documented as a divergence in SIDE_EFFECTS.md.
 */
export function formatSslStructDump(ssl: LegacyHostnameSsl): string {
  const validationErrors =
    ssl.validation_errors === undefined
      ? "<nil>"
      : `&[${ssl.validation_errors.map((e) => `{Message:${e.message}}`).join(" ")}]`;
  const validationRecords = (ssl.validation_records ?? [])
    .map((r) => `{TxtName:${r.txt_name} TxtValue:${r.txt_value}}`)
    .join(" ");
  return `{Status:${ssl.status} ValidationErrors:${validationErrors} ValidationRecords:[${validationRecords}]}`;
}
