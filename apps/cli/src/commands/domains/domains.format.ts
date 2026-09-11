import { type V1GetHostnameConfigOutput } from "@supabase/api/effect";

/**
 * The custom-hostname response shape. The Management API returns the same
 * structure for get / create / reverify / activate, so a single type covers
 * every status formatter.
 */
export type HostnameResponse = typeof V1GetHostnameConfigOutput.Type;

type HostnameSsl = HostnameResponse["data"]["result"]["ssl"];

type HostnameStatus = Exclude<HostnameResponse["status"], undefined>;

function getHostnameStatus(response: HostnameResponse): HostnameStatus | undefined {
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
 * Returns the exact string written to stderr for a hostname status.
 * Trailing-newline presence differs by branch and is part of the established output.
 */
export function formatHostnameStatus(response: HostnameResponse): string {
  switch (getHostnameStatus(response)) {
    case "5_services_reconfigured":
      return `Custom hostname setup completed. Project is now accessible at ${response.custom_hostname}.`;
    case "4_origin_setup_completed":
      return `Custom hostname configuration complete, and ready for activation.

Please ensure that your custom domain is set up as a CNAME record to your Supabase subdomain:
${response.custom_hostname} CNAME -> ${response.data.result.custom_origin_server}`;
    case "3_challenge_verified":
    case "2_initiated": {
      const ssl = response.data.result.ssl;
      if (ssl.status === "initializing") {
        return "Custom hostname setup is being initialized; please request re-verification in a few seconds.\n";
      }
      const validationErrors = ssl.validation_errors;
      if (validationErrors !== undefined && validationErrors.length > 0) {
        const errorMessages: string[] = [];
        for (const valError of validationErrors) {
          if (valError.message.includes("caa_error")) {
            return 'CAA mismatch; please remove any existing CAA records on your domain, or add one for "digicert.com"\n';
          }
          errorMessages.push(valError.message);
        }
        return `SSL validation errors: \n\t- ${errorMessages.join("\n\t- ")}\n`;
      }
      const validationRecords = ssl.validation_records ?? [];
      if (validationRecords.length !== 1) {
        return `expected a single SSL verification record, received: ${formatSslStructDump(ssl)}`;
      }
      let out =
        "Custom hostname verification in-progress; please configure the appropriate DNS entries and request re-verification.\nRequired outstanding validation records:\n";
      const rec = validationRecords[0];
      if (rec !== undefined && rec.txt_name !== "") {
        out += `\t${rec.txt_name} TXT -> ${rec.txt_value}`;
      }
      return out;
    }
    case "1_not_started":
      return "Custom hostname configuration not started.\n";
    default:
      return "";
  }
}

/**
 * Formats the ssl struct for the "more than one validation record" branch.
 * Deterministic but not byte-reproducible; see SIDE_EFFECTS.md.
 */
export function formatSslStructDump(ssl: HostnameSsl): string {
  const validationErrors =
    ssl.validation_errors === undefined
      ? "<nil>"
      : `&[${ssl.validation_errors.map((e) => `{Message:${e.message}}`).join(" ")}]`;
  const validationRecords = (ssl.validation_records ?? [])
    .map((r) => `{TxtName:${r.txt_name} TxtValue:${r.txt_value}}`)
    .join(" ");
  return `{Status:${ssl.status} ValidationErrors:${validationErrors} ValidationRecords:[${validationRecords}]}`;
}
