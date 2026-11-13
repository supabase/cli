import { Effect, Path, Result } from "effect";

import { isDocumentRecord } from "../config/cli-config-document.ts";
import { configFileName } from "./config-advice.ts";
import {
  invalid,
  missing,
  nonEmpty,
  readText,
  str,
  syncUnit,
  thrown,
  type CliConfigCheckUnit,
  type CliConfigUnitFinding,
} from "./config-check-core.ts";
import {
  apiTlsCertReadErrorMessage,
  apiTlsKeyReadErrorMessage,
  BUCKET_NAME_PATTERN,
  FUNCTION_SLUG_PATTERN,
  messageOf,
  missingApiTlsPath,
  narrowConfigEnum,
  resolveApiTlsPath,
} from "./config-validate.ts";
import { parseUrl } from "./storage-url.ts";

export const apiTlsFiles: CliConfigCheckUnit = {
  id: "api.tls.files",
  scope: ["api"],
  kind: "file",
  run: Effect.fnUntraced(function* (view, io) {
    if (view.get(["api", "enabled"]) !== true || view.get(["api", "tls", "enabled"]) !== true) {
      return [];
    }
    const cert = nonEmpty(view.get(["api", "tls", "cert_path"]));
    const key = nonEmpty(view.get(["api", "tls", "key_path"]));
    if (cert === undefined || key === undefined) return [];
    const path = yield* Path.Path;
    const findings: Array<CliConfigUnitFinding> = [];
    for (const [kind, configured] of [
      ["cert", cert],
      ["key", key],
    ] as const) {
      const read = yield* readText(io, resolveApiTlsPath(path, view.workdir, configured));
      if (Result.isFailure(read)) {
        const message = (kind === "cert" ? apiTlsCertReadErrorMessage : apiTlsKeyReadErrorMessage)(
          io.readFailureCause(read.failure),
        );
        findings.push(
          invalid(
            ["api", "tls", `${kind}_path`],
            message,
            `${kind === "cert" ? "certificate" : "private key"} file is not readable`,
            "point it at an existing file, relative to the supabase/ directory",
          ),
        );
      }
    }
    return findings;
  }),
};

export const dbRootKey = syncUnit({
  id: "db.root_key",
  scope: ["db", "root_key"],
  kind: "value",
  check: (view) => {
    const raw = view.written(["db", "root_key"]);
    return raw === undefined || typeof raw === "string"
      ? []
      : [
          invalid(
            ["db", "root_key"],
            "failed to parse config:\ndb.root_key: expected a table",
            "expected a string",
            "set root_key to a string",
            "invalid_type",
          ),
        ];
  },
});

export const analyticsBackendEnum = syncUnit({
  id: "analytics.backend.enum",
  scope: ["analytics", "backend"],
  kind: "value",
  check: (view) => {
    const backend = str(view.get(["analytics", "backend"]));
    if (backend === undefined) return [];
    try {
      narrowConfigEnum("analytics.backend", backend, ["postgres", "bigquery"]);
      return [];
    } catch (cause) {
      return [
        thrown(
          ["analytics", "backend"],
          cause,
          "expected one of postgres, bigquery",
          "use postgres or bigquery",
          "invalid_enum",
        ),
      ];
    }
  },
});

export const projectIdPresent = syncUnit({
  id: "project_id",
  scope: ["project_id"],
  kind: "value",
  check: (view) =>
    (str(view.get(["project_id"])) ?? "").length === 0 ? [missing(["project_id"])] : [],
});

export const apiPort = syncUnit({
  id: "api.port",
  scope: ["api"],
  kind: "requirement",
  check: (view) =>
    view.get(["api", "enabled"]) === true && view.get(["api", "port"]) === 0
      ? [missing(["api", "port"], ["api", "enabled"])]
      : [],
});

export const apiTlsPresence = syncUnit({
  id: "api.tls.paths",
  scope: ["api"],
  kind: "requirement",
  check: (view) => {
    if (view.get(["api", "enabled"]) !== true || view.get(["api", "tls", "enabled"]) !== true) {
      return [];
    }
    const absent = missingApiTlsPath(
      str(view.get(["api", "tls", "cert_path"])),
      str(view.get(["api", "tls", "key_path"])),
    );
    return absent === undefined ? [] : [missing(absent.split("."), ["api", "tls", "enabled"])];
  },
});

export const dbPort = syncUnit({
  id: "db.port",
  scope: ["db", "port"],
  kind: "value",
  check: (view) => (view.get(["db", "port"]) === 0 ? [missing(["db", "port"])] : []),
});

const SUPPORTED_POSTGRES_MAJOR_VERSIONS: ReadonlyArray<number> = [14, 15, 17];

export const dbMajorVersion = syncUnit({
  id: "db.major_version",
  scope: ["db", "major_version"],
  kind: "value",
  check: (view) => {
    const path = ["db", "major_version"] as const;
    const version = view.get(path);
    if (typeof version !== "number") return [];
    if (version === 0) return [missing(path)];
    if (version === 12) {
      return [
        invalid(
          path,
          "Postgres version 12.x is unsupported. To use the CLI, either start a new project or follow project migration steps here: https://supabase.com/docs/guides/database#migrating-between-projects.",
          "unsupported Postgres version",
          "Postgres 12 is no longer supported; follow https://supabase.com/docs/guides/database#migrating-between-projects",
        ),
      ];
    }
    if (version === 13) {
      return [
        invalid(
          path,
          "Postgres version 13.x is unsupported. To use the CLI, upgrade your project to Postgres 17, then set db.major_version = 17 in your project config: https://supabase.com/docs/guides/platform/upgrading.",
          "unsupported Postgres version",
          "upgrade the project to Postgres 17 and set db.major_version = 17; see https://supabase.com/docs/guides/platform/upgrading",
        ),
      ];
    }
    return SUPPORTED_POSTGRES_MAJOR_VERSIONS.includes(version)
      ? []
      : [
          invalid(
            path,
            `Failed reading config: Invalid db.major_version: ${version}.`,
            "unsupported Postgres version",
            `use one of ${SUPPORTED_POSTGRES_MAJOR_VERSIONS.join(", ")}`,
          ),
        ];
  },
});

export const storageBucketNames = syncUnit({
  id: "storage.buckets.name",
  scope: ["storage", "buckets"],
  kind: "value",
  entries: (view) => view.keys(["storage", "buckets"]),
  check: (_view, name) =>
    BUCKET_NAME_PATTERN.test(name)
      ? []
      : [
          invalid(
            ["storage", "buckets", name],
            `Invalid Bucket name: ${name}. Only lowercase letters, numbers, dots, hyphens, and spaces are allowed. (${BUCKET_NAME_PATTERN.source})`,
            "invalid bucket name",
            "use lowercase letters, numbers, dots, hyphens and spaces only",
          ),
        ],
});

export const studio = syncUnit({
  id: "studio",
  scope: ["studio"],
  kind: "requirement",
  check: (view) => {
    if (view.get(["studio", "enabled"]) !== true) return [];
    const findings: Array<CliConfigUnitFinding> = [];
    if (view.get(["studio", "port"]) === 0) {
      findings.push(missing(["studio", "port"], ["studio", "enabled"]));
    }
    try {
      parseUrl(str(view.get(["studio", "api_url"])) ?? "");
    } catch (cause) {
      findings.push(
        invalid(
          ["studio", "api_url"],
          `Invalid config for studio.api_url: ${messageOf(cause)}`,
          "not a valid URL",
          "use a full URL such as http://127.0.0.1:54321",
        ),
      );
    }
    return findings;
  },
});

export const localSmtpPort = syncUnit({
  id: "local_smtp.port",
  scope: ["local_smtp"],
  kind: "requirement",
  check: (view) =>
    view.get(["local_smtp", "enabled"]) === true && view.get(["local_smtp", "port"]) === 0
      ? [missing(["local_smtp", "port"], ["local_smtp", "enabled"])]
      : [],
});

export const functionSlugs = syncUnit({
  id: "functions.slug",
  scope: ["functions"],
  kind: "value",
  entries: (view) => view.keys(["functions"]),
  check: (_view, slug) =>
    FUNCTION_SLUG_PATTERN.test(slug)
      ? []
      : [
          invalid(
            ["functions", slug],
            `Invalid Function name: ${slug}. Must start with at least one letter, and only include alphanumeric characters, underscores, and hyphens. (${FUNCTION_SLUG_PATTERN.source})`,
            "invalid function name",
            "start with a letter; use letters, digits, underscores and hyphens only",
          ),
        ],
});

export const edgeRuntimeDenoVersion = syncUnit({
  id: "edge_runtime.deno_version",
  scope: ["edge_runtime", "deno_version"],
  kind: "value",
  check: (view) => {
    const path = ["edge_runtime", "deno_version"] as const;
    const version = view.get(path);
    if (typeof version !== "number") return [];
    if (version === 0) return [missing(path)];
    return version === 1 || version === 2
      ? []
      : [
          invalid(
            path,
            `Failed reading config: Invalid edge_runtime.deno_version: ${version}.`,
            "unsupported Deno version",
            "use 1 or 2",
          ),
        ];
  },
});

export const analytics = syncUnit({
  id: "analytics",
  scope: ["analytics"],
  kind: "requirement",
  check: (view) => {
    const backend = nonEmpty(view.get(["analytics", "backend"]));
    if (backend !== undefined && backend !== "postgres" && backend !== "bigquery") {
      return [
        invalid(
          ["analytics", "backend"],
          "failed to parse config:\nanalytics.backend: must be one of postgres, bigquery",
          "expected one of postgres, bigquery",
          "use postgres or bigquery",
          "invalid_enum",
        ),
      ];
    }
    if (view.get(["analytics", "enabled"]) !== true || backend !== "bigquery") return [];
    const gate = ["analytics", "enabled"] as const;
    const reason = "required when analytics.backend = bigquery";
    const findings: Array<CliConfigUnitFinding> = [];
    for (const key of ["gcp_project_id", "gcp_project_number"] as const) {
      if ((str(view.get(["analytics", key])) ?? "").length === 0) {
        findings.push(
          missing(["analytics", key], gate, {
            reason,
            help: `set ${key}, or set backend = "postgres"`,
          }),
        );
      }
    }
    if ((str(view.get(["analytics", "gcp_jwt_path"])) ?? "").length === 0) {
      findings.push(
        missing(["analytics", "gcp_jwt_path"], gate, {
          message: `Path to GCP Service Account Key must be provided in config, relative to ${view.configPath === undefined ? "config.toml" : configFileName(view.configPath)}: analytics.gcp_jwt_path`,
          reason,
          help: "set gcp_jwt_path to the service account key file, relative to supabase/",
        }),
      );
    }
    return findings;
  },
});

export const experimentalWebhooks = syncUnit({
  id: "experimental.webhooks",
  scope: ["experimental", "webhooks"],
  kind: "value",
  check: (view) =>
    isDocumentRecord(view.written(["experimental", "webhooks"])) &&
    view.get(["experimental", "webhooks", "enabled"]) !== true
      ? [
          invalid(
            ["experimental", "webhooks", "enabled"],
            "Webhooks cannot be deactivated. [experimental.webhooks] enabled can either be true or left undefined",
            "webhooks cannot be deactivated",
            "set enabled = true, or remove [experimental.webhooks]",
          ),
        ]
      : [],
});

const isValidJson = (value: string): boolean => {
  try {
    // oxlint-disable-next-line effecttsgo/prefer-schema-over-json -- Only parse success matters here.
    JSON.parse(value);
    return true;
  } catch {
    return false;
  }
};

export const pgdeltaFormatOptions = syncUnit({
  id: "experimental.pgdelta.format_options",
  scope: ["experimental", "pgdelta", "format_options"],
  kind: "value",
  check: (view) => {
    const options = str(view.get(["experimental", "pgdelta", "format_options"])) ?? "";
    return options !== "" && !isValidJson(options)
      ? [
          invalid(
            ["experimental", "pgdelta", "format_options"],
            "Invalid config for experimental.pgdelta.format_options: must be valid JSON",
            "not valid JSON",
            "use a JSON object string",
          ),
        ]
      : [];
  },
});
