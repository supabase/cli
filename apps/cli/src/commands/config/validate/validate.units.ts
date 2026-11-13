import {
  cliConfigExternalProviderIssues,
  EXTERNAL_PROVIDER_IDS,
  cliConfigMigrationChecksIssues,
  cliConfigServiceVersionIssues,
  cliConfigSmsProviderIssues,
  cliConfigSmtpIssues,
  type CliConfigTableRuleIssue,
} from "@supabase/config/internal";

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
  SMS_FIELD_ENTRIES,
  SMTP_FIELDS,
  smtpField,
} from "../../../command-internal/config-check-auth-units.ts";
import {
  countingUnit,
  finding,
  invalid,
  missing,
  splitFieldEntry,
  str,
  syncUnit,
  type CliConfigCheckUnit,
  type CliConfigUnitFinding,
  type CliConfigView,
  type Segments,
} from "../../../command-internal/config-check-core.ts";
import { storageBucketFileSizeLimits } from "../../../command-internal/config-check-platform-units.ts";
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
    twin: `auth.email.smtp.${field}`,
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
  twin: "auth.sms.provider",
  scope: ["auth", "sms"],
  entries: () => SMS_FIELD_ENTRIES,
  check: (view, entry) => {
    const [name, field] = splitFieldEntry(entry);
    const provider = firstEnabledSmsProvider(view);
    if (provider?.[0] !== name) return [];
    // The rule reports the first empty field, so the others get a non-empty placeholder to keep this entry to its own field.
    return tableRuleFindings(
      ["auth", "sms"],
      cliConfigSmsProviderIssues({
        [name]: {
          enabled: true,
          ...Object.fromEntries(
            provider[1].map((other) => [
              other,
              other === field ? str(view.get(["auth", "sms", name, other])) : "-",
            ]),
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
    twin: "auth.external.required",
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
  scope: (service) => ["local", "services", service, "version"],
  kind: "value",
  entries: (view) => view.keys(["local", "services"]),
  check: (view, service) => {
    const version = str(view.get(["local", "services", service, "version"]));
    return version === undefined
      ? []
      : tableRuleFindings(
          ["local", "services"],
          cliConfigServiceVersionIssues({ [service]: { version } }),
          "invalid_value",
        );
  },
});

const CHECKS_PATH = ["db", "migrations", "checks"];
const EXCLUDE_PATH = [...CHECKS_PATH, "exclude"];

const migrationCheckFindings = (section: Record<string, unknown>) =>
  tableRuleFindings(CHECKS_PATH, cliConfigMigrationChecksIssues(section), "invalid_value");

const migrationCheckRuleUnit = syncUnit({
  id: "db.migrations.checks.rule",
  scope: (rule) => [...CHECKS_PATH, rule],
  kind: "value",
  entries: (view) => view.keys(CHECKS_PATH).filter((key) => key !== "exclude"),
  check: (view, rule) => migrationCheckFindings({ [rule]: view.written([...CHECKS_PATH, rule]) }),
});

const migrationCheckExcludeShapeUnit = syncUnit({
  id: "db.migrations.checks.exclude",
  scope: EXCLUDE_PATH,
  kind: "value",
  check: (view) =>
    view.has(EXCLUDE_PATH) && !view.hasTable(EXCLUDE_PATH)
      ? migrationCheckFindings({ exclude: view.written(EXCLUDE_PATH) })
      : [],
});

const migrationCheckExclusionUnit = syncUnit({
  id: "db.migrations.checks.exclude.rule",
  scope: (rule) => [...EXCLUDE_PATH, rule],
  kind: "value",
  entries: (view) => view.keys(EXCLUDE_PATH),
  check: (view, rule) =>
    migrationCheckFindings({ exclude: { [rule]: view.written([...EXCLUDE_PATH, rule]) } }),
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
  check: (view, name) => {
    const written = view.written(["remotes", name, "project_id"]);
    return (written !== undefined && typeof written !== "string") ||
      isValidRemoteProjectId(str(written))
      ? []
      : [
          invalid(
            ["remotes", name, "project_id"],
            remoteProjectIdFormatMessage(name),
            "not a valid project ref",
            "use the 20-character project ref",
            "remote_project_id",
          ),
        ];
  },
});

const remoteProjectIdDuplicates = countingUnit({
  id: "remotes.project_id.duplicates",
  scope: ["remotes"],
  check: (view) => {
    const seen = new Map<string, string>();
    const findings: Array<CliConfigUnitFinding> = [];
    let unsettled: Segments | undefined;
    for (const name of remoteNames(view)) {
      const at = ["remotes", name, "project_id"];
      if (!view.isKnown(at)) {
        unsettled ??= at;
        continue;
      }
      const other = earlierRemoteWithProjectId(seen, name, str(view.written(at)));
      if (other !== undefined) {
        findings.push(
          invalid(
            at,
            `duplicate project_id for [remotes.${tomlSegment(name)}] and [remotes.${tomlSegment(other)}]`,
            `same project_id as remotes.${tomlSegment(other)}`,
            "give every remote its own project_id",
            "remote_project_id",
          ),
        );
      }
    }
    // Reading the first unknown id records the dependency, so a validator defers this check unless known duplicates already settle it.
    if (findings.length === 0 && unsettled !== undefined) view.written(unsettled);
    return findings;
  },
});

/** Checks `config validate` adds to the local ones: table rules, remote project ids and the `db` path's bucket size limits. */
export const VALIDATE_ONLY_UNITS: ReadonlyArray<CliConfigCheckUnit> = [
  storageBucketFileSizeLimits,
  ...smtpTableUnits,
  smsTableRule,
  ...externalTableUnits,
  serviceVersionRule,
  migrationCheckRuleUnit,
  migrationCheckExcludeShapeUnit,
  migrationCheckExclusionUnit,
  remoteProjectIdFormat,
  remoteProjectIdDuplicates,
];
