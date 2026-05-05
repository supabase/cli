import { inferFunctionsManifest, type ResolvedFunctionConfig } from "@supabase/config";
import { makeApiClient } from "@supabase/api/effect";
import { Effect, Option, Redacted } from "effect";
import { CommandRuntime } from "../../../../shared/runtime/command-runtime.service.ts";
import { Credentials } from "../../../auth/credentials.service.ts";
import { CliConfig } from "../../../config/cli-config.service.ts";
import { ProjectLinkState } from "../../../config/project-link-state.service.ts";
import { RuntimeInfo } from "../../../../shared/runtime/runtime-info.service.ts";
import { Output } from "../../../../shared/output/output.service.ts";
import { outputTable } from "../../../../shared/output/table.ts";

type RemoteReason = "not_linked" | "not_authenticated" | "request_failed";

interface RemoteFunction {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
  readonly status: "ACTIVE" | "REMOVED" | "THROTTLED";
  readonly version: number;
  readonly created_at: number;
  readonly updated_at: number;
  readonly verify_jwt?: boolean;
  readonly import_map?: boolean;
  readonly entrypoint_path?: string;
  readonly import_map_path?: string;
  readonly ezbr_sha256?: string;
}

interface RemoteSource {
  readonly checked: boolean;
  readonly project_ref?: string;
  readonly reason?: RemoteReason;
}

interface RemoteInventory {
  readonly source: RemoteSource;
  readonly functions: Readonly<Record<string, RemoteFunction>>;
}

interface FunctionInventoryItem {
  readonly slug: string;
  readonly local: ResolvedFunctionConfig | null;
  readonly remote: RemoteFunction | null;
}

interface RemoteTextMessage {
  readonly level: "info" | "warn";
  readonly message: string;
}

function formatUtcTimestamp(timestamp: number | undefined): string {
  if (timestamp === undefined) {
    return "-";
  }

  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) {
    return "Invalid date";
  }

  return date.toISOString().replace("T", " ").slice(0, 19);
}

function remoteTextMessage(source: RemoteSource): RemoteTextMessage | undefined {
  switch (source.reason) {
    case "not_linked":
      return {
        level: "info",
        message: "Showing local functions only. Link a project to include deployed functions.",
      };
    case "not_authenticated":
      return {
        level: "info",
        message:
          "Showing local functions only. Log in to include deployed functions from the linked project.",
      };
    case "request_failed":
      return {
        level: "warn",
        message: "Remote deployments could not be fetched; showing local inventory only.",
      };
    case undefined:
      return undefined;
  }
}

function localStatus(config: ResolvedFunctionConfig | null): string {
  if (config === null) {
    return "-";
  }

  return config.enabled ? "enabled" : "disabled";
}

function entrypointFor(item: FunctionInventoryItem): string {
  return item.local?.entrypoint ?? item.remote?.entrypoint_path ?? "-";
}

function toRecord<T extends { readonly slug: string }>(items: ReadonlyArray<T>): Record<string, T> {
  return Object.fromEntries(items.map((item) => [item.slug, item]));
}

function resolveToken(
  configuredToken: Option.Option<Redacted.Redacted<string>>,
  storedToken: Option.Option<Redacted.Redacted<string>>,
): Option.Option<Redacted.Redacted<string>> {
  return Option.isSome(configuredToken) ? configuredToken : storedToken;
}

const loadRemoteInventory = Effect.fnUntraced(function* () {
  const projectLinkState = yield* ProjectLinkState;
  const cliConfig = yield* CliConfig;
  const credentials = yield* Credentials;
  const commandRuntime = yield* CommandRuntime;

  const maybeLinkState = yield* projectLinkState.load;
  if (Option.isNone(maybeLinkState)) {
    return {
      source: { checked: false, reason: "not_linked" },
      functions: {},
    } satisfies RemoteInventory;
  }

  const projectRef = maybeLinkState.value.project.ref;
  const storedToken = yield* credentials.getAccessToken;
  const token = resolveToken(cliConfig.accessToken, storedToken);
  if (Option.isNone(token)) {
    return {
      source: { checked: false, project_ref: projectRef, reason: "not_authenticated" },
      functions: {},
    } satisfies RemoteInventory;
  }

  const api = yield* makeApiClient({
    baseUrl: cliConfig.apiUrl,
    accessToken: token.value,
    userAgent: "@supabase/cli",
    headers: {
      "X-Supabase-Command": commandRuntime.commandPath.join(" "),
      "X-Supabase-Command-Run-ID": commandRuntime.commandRunId,
    },
  });

  return yield* api.v1.listAllFunctions({ ref: projectRef }).pipe(
    Effect.match({
      onFailure: () =>
        ({
          source: { checked: false, project_ref: projectRef, reason: "request_failed" },
          functions: {},
        }) satisfies RemoteInventory,
      onSuccess: (functions) =>
        ({
          source: { checked: true, project_ref: projectRef },
          functions: toRecord(functions),
        }) satisfies RemoteInventory,
    }),
  );
});

function mergeInventory(
  local: Readonly<Record<string, ResolvedFunctionConfig>>,
  remote: Readonly<Record<string, RemoteFunction>>,
): ReadonlyArray<FunctionInventoryItem> {
  return [...new Set([...Object.keys(local), ...Object.keys(remote)])]
    .sort((left, right) => left.localeCompare(right))
    .map((slug) => ({
      slug,
      local: local[slug] ?? null,
      remote: remote[slug] ?? null,
    }));
}

export const functionsList = Effect.fnUntraced(function* () {
  const output = yield* Output;
  const runtimeInfo = yield* RuntimeInfo;

  yield* output.intro("List Edge Functions");

  const local = yield* inferFunctionsManifest({ cwd: runtimeInfo.cwd });
  const remote = yield* loadRemoteInventory();
  const functions = mergeInventory(local, remote.functions);
  const sources = {
    local: { checked: true },
    remote: remote.source,
  };

  if (output.format !== "text") {
    yield* output.success("Edge Functions inventory.", { functions, sources });
    return;
  }

  if (functions.length === 0) {
    yield* output.outro("No Edge Functions found.");
    const remoteMessage = remoteTextMessage(remote.source);
    if (remoteMessage !== undefined) {
      yield* output[remoteMessage.level](remoteMessage.message);
    }
    return;
  }

  yield* outputTable(
    ["SLUG", "LOCAL", "REMOTE", "VERSION", "UPDATED_AT (UTC)", "ENTRYPOINT"],
    functions,
    (item) => [
      item.slug,
      localStatus(item.local),
      item.remote?.status ?? "-",
      item.remote?.version === undefined ? "-" : String(item.remote.version),
      formatUtcTimestamp(item.remote?.updated_at),
      entrypointFor(item),
    ],
  );

  const remoteMessage = remoteTextMessage(remote.source);
  if (remoteMessage !== undefined) {
    yield* output[remoteMessage.level](remoteMessage.message);
  }

  yield* output.outro(
    `Found ${functions.length} Edge Function${functions.length === 1 ? "" : "s"}.`,
  );
});
