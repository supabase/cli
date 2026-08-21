import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { makeApiClient, type OperationOutput } from "@supabase/api/effect";
import { Effect } from "effect";
import { FetchHttpClient } from "effect/unstable/http";

import {
  deriveLiveProjectHost,
  keepLiveProject,
  liveAccessToken,
  liveApiUrl,
  liveOrgId,
  liveProjectName,
  liveRegion,
} from "./live-env.ts";

const PROJECT_REF_RE = /^[a-z]{20}$/u;
const TERMINAL_BAD_STATUSES = new Set(["INIT_FAILED", "RESTORE_FAILED", "REMOVED"]);
const PROFILE_NAME = "supabase-cli-live";

type Project = OperationOutput<"v1GetProject">;
type Organization = OperationOutput<"v1ListAllOrganizations">[number];
type ApiKey = OperationOutput<"v1GetProjectApiKeys">[number];
type Region =
  | "us-east-1"
  | "us-east-2"
  | "us-west-1"
  | "us-west-2"
  | "ap-east-1"
  | "ap-southeast-1"
  | "ap-northeast-1"
  | "ap-northeast-2"
  | "ap-southeast-2"
  | "eu-west-1"
  | "eu-west-2"
  | "eu-west-3"
  | "eu-north-1"
  | "eu-central-1"
  | "eu-central-2"
  | "ca-central-1"
  | "ap-south-1"
  | "sa-east-1";

const REGIONS: ReadonlyArray<Region> = [
  "us-east-1",
  "us-east-2",
  "us-west-1",
  "us-west-2",
  "ap-east-1",
  "ap-southeast-1",
  "ap-northeast-1",
  "ap-northeast-2",
  "ap-southeast-2",
  "eu-west-1",
  "eu-west-2",
  "eu-west-3",
  "eu-north-1",
  "eu-central-1",
  "eu-central-2",
  "ca-central-1",
  "ap-south-1",
  "sa-east-1",
];

function supportedRegion(value: string): Region {
  const region = REGIONS.find((candidate) => candidate === value);
  if (region !== undefined) return region;
  throw new Error(`Unsupported SUPABASE_LIVE_REGION ${JSON.stringify(value)}`);
}

function apiError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function makeLiveApi() {
  return makeApiClient({ baseUrl: liveApiUrl(), accessToken: liveAccessToken() }).pipe(
    Effect.provide(FetchHttpClient.layer),
  );
}

async function runLiveEffect<T>(effect: Effect.Effect<T, unknown, never>): Promise<T> {
  return Effect.runPromise(effect);
}

function uniqueProjectName(): string {
  const runId = process.env["GITHUB_RUN_ID"] ?? process.env["CI_JOB_ID"] ?? String(Date.now());
  return `${liveProjectName()}-${runId}-${randomUUID().slice(0, 8)}`;
}

function databasePassword(): string {
  return `supabase-cli-live-${randomBytes(12).toString("hex")}`;
}

async function resolveOrganization(): Promise<Organization> {
  const api = await runLiveEffect(makeLiveApi());
  const organizations = await runLiveEffect(api.v1.listAllOrganizations());
  const requested = liveOrgId();
  const organization =
    (requested === undefined
      ? organizations[0]
      : organizations.find(
          (candidate) => candidate.id === requested || candidate.slug === requested,
        )) ?? undefined;
  if (organization === undefined) {
    throw new Error(
      requested === undefined
        ? "No organizations found; cannot create the live project"
        : `Organization ${requested} was not found; cannot create the live project`,
    );
  }
  return organization;
}

async function createProject(name: string, password: string): Promise<string> {
  const organization = await resolveOrganization();
  const api = await runLiveEffect(makeLiveApi());
  const project = await runLiveEffect(
    api.v1.createAProject({
      name,
      db_pass: password,
      organization_slug: organization.slug,
      region: supportedRegion(liveRegion()),
    }),
  );
  if (!PROJECT_REF_RE.test(project.ref)) {
    throw new Error(`Unexpected project ref from project creation: ${project.ref}`);
  }
  return project.ref;
}

async function deleteProject(ref: string): Promise<void> {
  const api = await runLiveEffect(makeLiveApi());
  await runLiveEffect(api.v1.deleteAProject({ ref }));
}

async function waitForProject(ref: string): Promise<Project> {
  const deadline = Date.now() + 300_000;
  while (Date.now() < deadline) {
    const api = await runLiveEffect(makeLiveApi());
    const project = await runLiveEffect(api.v1.getProject({ ref }));
    if (project.status === "ACTIVE_HEALTHY") return project;
    if (TERMINAL_BAD_STATUSES.has(project.status)) {
      throw new Error(`Project ${ref} entered terminal status ${project.status}`);
    }
    await Effect.runPromise(Effect.sleep("5 seconds"));
  }
  throw new Error(`Project ${ref} did not become ACTIVE_HEALTHY within 300000ms`);
}

async function resolveKeys(ref: string): Promise<{ anonKey: string; serviceRoleKey: string }> {
  const api = await runLiveEffect(makeLiveApi());
  const keys = await runLiveEffect(api.v1.getProjectApiKeys({ ref, reveal: true }));
  const keyValue = (key: ApiKey): string | undefined =>
    key.api_key === null || key.api_key === undefined ? undefined : key.api_key;
  const anon = keys.find((key) => key.name === "anon");
  const serviceRole =
    keys.find((key) => key.name === "service_role") ??
    keys.find((key) => key.api_key?.startsWith("sb_secret_"));
  const anonKey = anon === undefined ? undefined : keyValue(anon);
  const serviceRoleKey = serviceRole === undefined ? undefined : keyValue(serviceRole);
  if (anonKey === undefined || serviceRoleKey === undefined) {
    throw new Error(`Project ${ref} returned no anon and service-role API keys`);
  }
  return { anonKey, serviceRoleKey };
}

async function resolveDbUrl(ref: string, password: string): Promise<string> {
  const api = await runLiveEffect(makeLiveApi());
  const config = await runLiveEffect(api.v1.getProjectPgbouncerConfig({ ref }));
  if (config.connection_string === undefined) {
    throw new Error(`Project ${ref} returned no pooler connection string`);
  }
  const url = new URL(config.connection_string);
  url.password = password;
  url.port = "5432";
  if (!url.searchParams.has("connect_timeout")) url.searchParams.set("connect_timeout", "30");
  return url.toString();
}

async function createStorageBucket(
  ref: string,
  host: string,
  serviceRoleKey: string,
  bucket: string,
): Promise<void> {
  const response = await fetch(`https://${ref}.${host}/storage/v1/bucket`, {
    method: "POST",
    headers: { Authorization: `Bearer ${serviceRoleKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ id: bucket, name: bucket, public: false }),
  });
  if (!response.ok && response.status !== 409) {
    throw new Error(
      `Failed to create storage bucket ${bucket}: ${response.status} ${await response.text()}`,
    );
  }
}

async function writeProfile(
  projectRef: string,
  projectHost: string,
  dbUrl: string,
): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "supabase-live-profile-"));
  const profilePath = path.join(directory, "profile.yaml");
  const poolerHost = new URL(dbUrl).hostname;
  try {
    await writeFile(
      profilePath,
      [
        `name: ${PROFILE_NAME}`,
        `api_url: ${JSON.stringify(liveApiUrl())}`,
        `dashboard_url: ${JSON.stringify(liveApiUrl())}`,
        `project_host: ${projectHost}`,
        `pooler_host: ${poolerHost}`,
        `# provisioned project: ${projectRef}`,
        "",
      ].join("\n"),
    );
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
  return profilePath;
}

export interface LiveProjectEnvironment {
  readonly project: {
    readonly ref: string;
    readonly dbUrl: string;
    readonly dbPassword: string;
    readonly anonKey: string;
    readonly serviceRoleKey: string;
    readonly functionsUrl: string;
    readonly storageBucket: string;
  };
  readonly profilePath: string;
}

export async function provisionLiveEnvironment(): Promise<LiveProjectEnvironment> {
  const password = databasePassword();
  const ref = await createProject(uniqueProjectName(), password);
  let profilePath: string | undefined;
  try {
    const project = await waitForProject(ref);
    const projectHost = deriveLiveProjectHost(project.database.host, ref);
    const keys = await resolveKeys(ref);
    const dbUrl = await resolveDbUrl(ref, password);
    const storageBucket = "supabase-cli-live-bucket";
    await createStorageBucket(ref, projectHost, keys.serviceRoleKey, storageBucket);
    profilePath = await writeProfile(ref, projectHost, dbUrl);
    return {
      project: {
        ref,
        dbUrl,
        dbPassword: password,
        anonKey: keys.anonKey,
        serviceRoleKey: keys.serviceRoleKey,
        functionsUrl: `https://${ref}.${projectHost}/functions/v1`,
        storageBucket,
      },
      profilePath,
    };
  } catch (error) {
    if (profilePath !== undefined)
      await rm(path.dirname(profilePath), { recursive: true, force: true });
    if (!keepLiveProject()) await deleteProject(ref).catch(() => undefined);
    throw apiError(error);
  }
}

export async function cleanupLiveEnvironment(environment: LiveProjectEnvironment): Promise<void> {
  let profileError: unknown;
  try {
    await rm(path.dirname(environment.profilePath), { recursive: true, force: true });
  } catch (error) {
    profileError = error;
  }
  if (!keepLiveProject()) await deleteProject(environment.project.ref);
  else console.log(`SUPABASE_LIVE_KEEP_PROJECT=1 — leaving ${environment.project.ref} alive`);
  if (profileError !== undefined) throw apiError(profileError);
}
