import {
  cliConfigExternalProviderIssues,
  EXTERNAL_PROVIDER_IDS,
  cliConfigMigrationChecksIssues,
  cliConfigServiceVersionIssues,
  cliConfigSmsProviderIssues,
  cliConfigSmtpIssues,
  type CliConfigTableRuleIssue,
} from "@supabase/config/internal";

import { isDocumentRecord } from "../../../config/cli-config-document.ts";
import {
  earlierRemoteWithProjectId,
  isValidRemoteProjectId,
  remoteProjectIdFormatMessage,
} from "../../../config/cli-config-remote.ts";
import {
  externalEnabled,
  externalNames,
  externalText,
  firstEnabledSmsProvider,
  SMTP_FIELDS,
  smtpField,
} from "../../../command-internal/config-check-auth-units.ts";
import {
  countingUnit,
  finding,
  invalid,
  missing,
  str,
  syncUnit,
  type CliConfigCheckUnit,
  type CliConfigUnitFinding,
  type CliConfigView,
  type Segments,
} from "../../../command-internal/config-check-core.ts";
import type { ConfigValidationIssueCode } from "../../../command-internal/config-validate.ts";
import { SMTP_ENABLED_PATH, SMTP_PATH } from "../../../command-internal/local-config-helpers.ts";

const tableRuleFindings = (
  prefix: Segments,
  issues: ReadonlyArray<CliConfigTableRuleIssue>,
  code: ConfigValidationIssueCode,
  gateOf?: (issuePath: Segments) => Segments,
): ReadonlyArray<CliConfigUnitFinding> =>
  issues.map((issue) => {
    const path = [...prefix, ...issue.path.map(String)];
    return gateOf === undefined
      ? finding(path, code, issue.message, "invalid value")
      : missing(path, gateOf(issue.path.map(String)), { message: issue.message });
  });

const smtpTableUnits = SMTP_FIELDS.map((field) =>
  syncUnit({
    id: `auth.email.smtp.table.${field}`,
    scope: SMTP_PATH,
    kind: "requirement",
    check: (view) =>
      tableRuleFindings(
        SMTP_PATH,
        cliConfigSmtpIssues(
          {
            enabled: view.get(SMTP_ENABLED_PATH) === true,
            get host() {
              return str(smtpField(view, "host"));
            },
            get port() {
              const port = smtpField(view, "port");
              return typeof port === "number" ? port : undefined;
            },
            get user() {
              return str(smtpField(view, "user"));
            },
            get pass() {
              return str(smtpField(view, "pass"));
            },
            get admin_email() {
              return str(smtpField(view, "admin_email"));
            },
          },
          [field],
        ),
        "missing_required",
        () => SMTP_ENABLED_PATH,
      ),
  }),
);

const smsTableRule = countingUnit({
  id: "auth.sms.table",
  scope: ["auth", "sms"],
  check: (view) => {
    const provider = firstEnabledSmsProvider(view);
    if (provider === undefined) return [];
    const [name, fields] = provider;
    return tableRuleFindings(
      ["auth", "sms"],
      cliConfigSmsProviderIssues({
        [name]: {
          enabled: true,
          ...Object.fromEntries(
            fields.map((field) => [field, str(view.get(["auth", "sms", name, field]))]),
          ),
        },
      }),
      "missing_required",
      (issuePath) => ["auth", "sms", issuePath[0] ?? name, "enabled"],
    );
  },
});

const SCHEMA_PROVIDERS: ReadonlySet<string> = new Set(EXTERNAL_PROVIDER_IDS);

const externalTableUnits = (["client_id", "secret"] as const).map((field) =>
  syncUnit({
    id: `auth.external.table.${field}`,
    scope: (name) => ["auth", "external", name],
    kind: "requirement",
    entries: (view) => externalNames(view).filter((name) => SCHEMA_PROVIDERS.has(name)),
    check: (view, name) => {
      if (!externalEnabled(view, name)) return [];
      return tableRuleFindings(
        ["auth", "external", name],
        cliConfigExternalProviderIssues(
          name,
          {
            enabled: true,
            get client_id() {
              return externalText(view, name, "client_id") ?? "";
            },
            get secret() {
              return externalText(view, name, "secret");
            },
          },
          field,
        ),
        "missing_required",
        () => ["auth", "external", name, "enabled"],
      );
    },
  }),
);

const serviceVersionRule = syncUnit({
  id: "local.services.version",
  scope: (service) => ["local", "services", service],
  kind: "value",
  entries: (view) => view.keys(["local", "services"]),
  check: (view, service) => {
    const entry = view.get(["local", "services", service]);
    const version = isDocumentRecord(entry) ? str(entry["version"]) : undefined;
    return version === undefined
      ? []
      : tableRuleFindings(
          ["local", "services"],
          cliConfigServiceVersionIssues({ [service]: { version } }),
          "invalid_value",
        );
  },
});

const migrationChecksRule = syncUnit({
  id: "db.migrations.checks",
  scope: ["db", "migrations", "checks"],
  kind: "value",
  check: (view) => {
    const section = view.written(["db", "migrations", "checks"]);
    return isDocumentRecord(section)
      ? tableRuleFindings(
          ["db", "migrations", "checks"],
          cliConfigMigrationChecksIssues(section),
          "invalid_value",
        )
      : [];
  },
});

const TOML_BARE_KEY = /^[A-Za-z0-9_-]+$/;

export const tomlSegment = (segment: string): string =>
  TOML_BARE_KEY.test(segment) ? segment : JSON.stringify(segment);

const remoteNames = (view: CliConfigView): ReadonlyArray<string> => view.keys(["remotes"]);

const remoteProjectIdFormat = syncUnit({
  id: "remotes.project_id.format",
  scope: (name) => ["remotes", name, "project_id"],
  kind: "value",
  entries: remoteNames,
  check: (view, name) =>
    isValidRemoteProjectId(str(view.written(["remotes", name, "project_id"])))
      ? []
      : [
          invalid(
            ["remotes", name, "project_id"],
            remoteProjectIdFormatMessage(name),
            "not a valid project ref",
            "use the 20-character project ref",
            "remote_project_id",
          ),
        ],
});

const remoteProjectIdDuplicates = countingUnit({
  id: "remotes.project_id.duplicates",
  scope: ["remotes"],
  check: (view) => {
    const seen = new Map<string, string>();
    let unsettled: Segments | undefined;
    for (const name of remoteNames(view)) {
      const at = ["remotes", name, "project_id"];
      if (!view.isKnown(at)) {
        unsettled ??= at;
        continue;
      }
      const other = earlierRemoteWithProjectId(seen, name, str(view.written(at)));
      if (other !== undefined) {
        return [
          invalid(
            at,
            `duplicate project_id for [remotes.${tomlSegment(name)}] and [remotes.${tomlSegment(other)}]`,
            `same project_id as remotes.${tomlSegment(other)}`,
            "give every remote its own project_id",
            "remote_project_id",
          ),
        ];
      }
    }
    // Reading the first unknown id records the dependency, so a validator defers this check.
    if (unsettled !== undefined) view.written(unsettled);
    return [];
  },
});

/** Checks only `config validate` runs: the table rules and the remote project ids. */
export const VALIDATE_ONLY_UNITS: ReadonlyArray<CliConfigCheckUnit> = [
  ...smtpTableUnits,
  smsTableRule,
  ...externalTableUnits,
  serviceVersionRule,
  migrationChecksRule,
  remoteProjectIdFormat,
  remoteProjectIdDuplicates,
];
