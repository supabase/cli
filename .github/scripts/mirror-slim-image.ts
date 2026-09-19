/**
 * GHCR → ECR Public copy for slim images and optional native OCI tags.
 * Registry logins stay in the workflow; this script is the replayable logic.
 *
 *   bun .github/scripts/mirror-slim-image.ts validate
 *   bun .github/scripts/mirror-slim-image.ts verify-digest
 *   bun .github/scripts/mirror-slim-image.ts ensure-repo
 *   bun .github/scripts/mirror-slim-image.ts copy-image
 *   bun .github/scripts/mirror-slim-image.ts copy-natives
 */

import { appendFileSync } from "node:fs";

import {
  DEST_REGISTRY,
  InvalidPayloadError,
  SOURCE_REGISTRY,
  digestReference,
  parseNatives,
  validateMirrorDispatch,
  type NativeArtifact,
} from "./slim-mirror-payload.ts";

export type CommandResult = {
  readonly ok: boolean;
  readonly stdout: string;
  readonly stderr: string;
};

export type RunCommand = (argv: ReadonlyArray<string>) => Promise<CommandResult>;

export type MirrorIo = {
  readonly env: NodeJS.Dict<string>;
  readonly run: RunCommand;
  readonly log?: (message: string) => void;
  readonly readText?: (path: string) => Promise<string>;
  readonly writeOutput?: (fields: Readonly<Record<string, string>>) => void;
};

const usage = `Usage:
  bun .github/scripts/mirror-slim-image.ts validate
  bun .github/scripts/mirror-slim-image.ts verify-digest
  bun .github/scripts/mirror-slim-image.ts ensure-repo
  bun .github/scripts/mirror-slim-image.ts copy-image
  bun .github/scripts/mirror-slim-image.ts copy-natives`;

const envValue = (env: NodeJS.Dict<string>, key: string): string => env[key] ?? "";

const requireEnv = (env: NodeJS.Dict<string>, key: string): string => {
  const value = envValue(env, key).trim();
  if (value === "") throw new InvalidPayloadError(`missing required environment variable: ${key}`);
  return value;
};

const writeGithubOutput = (
  env: NodeJS.Dict<string>,
  fields: Readonly<Record<string, string>>,
  writeOutput?: MirrorIo["writeOutput"],
): void => {
  if (writeOutput !== undefined) {
    writeOutput(fields);
    return;
  }
  const body = `${Object.entries(fields)
    .map(([key, value]) => `${key}=${value}`)
    .join("\n")}\n`;
  const path = env["GITHUB_OUTPUT"];
  if (path !== undefined && path.trim() !== "") appendFileSync(path, body);
  else process.stdout.write(body);
};

export const verifyDigest = async (options: {
  readonly reference: string;
  readonly digest: string;
  readonly run: RunCommand;
  readonly log?: (message: string) => void;
}): Promise<void> => {
  const log = options.log ?? console.log;
  const head = await options.run(["regctl", "manifest", "head", options.reference]);
  const live = head.stdout.trim();
  if (!head.ok || live !== options.digest) {
    const resolved = head.ok ? live : live || "missing";
    const detail = !head.ok && head.stderr.trim() !== "" ? `: ${head.stderr.trim()}` : "";
    throw new InvalidPayloadError(
      `${options.reference} resolves to ${resolved}, expected ${options.digest}${detail}`,
    );
  }
  log(`${options.reference} resolves to ${options.digest}`);
};

export const ensureEcrPublicRepo = async (options: {
  readonly service: string;
  readonly run: RunCommand;
  readonly log?: (message: string) => void;
}): Promise<void> => {
  const log = options.log ?? console.log;
  const repoName = `cli/${options.service}`;
  const described = await options.run([
    "aws",
    "ecr-public",
    "describe-repositories",
    "--repository-names",
    repoName,
    "--region",
    "us-east-1",
  ]);
  if (described.ok) {
    log(`ECR Public repository ${repoName} exists`);
    return;
  }
  const created = await options.run([
    "aws",
    "ecr-public",
    "create-repository",
    "--repository-name",
    repoName,
    "--region",
    "us-east-1",
  ]);
  if (created.ok) {
    log(`created ECR Public repository ${repoName}`);
    return;
  }
  const detail = `${created.stdout}\n${created.stderr}`;
  if (detail.includes("RepositoryAlreadyExistsException")) {
    log(`ECR Public repository ${repoName} was created concurrently`);
    return;
  }
  if (detail.trim() !== "") log(detail.trim());
  throw new InvalidPayloadError(
    `ECR Public repository '${repoName}' does not exist and this role cannot create it (missing ecr-public:CreateRepository). Create it once manually — aws ecr-public create-repository --repository-name '${repoName}' --region us-east-1 — then re-run this workflow.`,
  );
};

export const copyImage = async (options: {
  readonly source: string;
  readonly destination: string;
  readonly digest: string;
  readonly run: RunCommand;
}): Promise<void> => {
  const copied = await options.run([
    "regctl",
    "image",
    "copy",
    "--referrers",
    "--digest-tags",
    digestReference(options.source, options.digest),
    options.destination,
  ]);
  if (!copied.ok)
    throw new InvalidPayloadError(copied.stderr.trim() || `copy failed: ${options.source}`);
};

export const copyNatives = async (options: {
  readonly service: string;
  readonly natives: ReadonlyArray<NativeArtifact>;
  readonly run: RunCommand;
  readonly log?: (message: string) => void;
}): Promise<number> => {
  const log = options.log ?? console.log;
  let failed = 0;
  for (const { tag, digest } of options.natives) {
    const source = `${SOURCE_REGISTRY}/${options.service}:${tag}`;
    const destination = `${DEST_REGISTRY}/${options.service}:${tag}`;
    const head = await options.run(["regctl", "manifest", "head", source]);
    const sourceDigest = head.stdout.trim();
    if (!head.ok) {
      log(`::warning::native source ${source} is missing`);
      if (head.stderr.trim() !== "") log(head.stderr.trim());
      failed += 1;
      continue;
    }
    if (sourceDigest !== digest) {
      log(`::warning::native source ${source} resolves to ${sourceDigest}, expected ${digest}`);
      failed += 1;
      continue;
    }
    const copied = await options.run([
      "regctl",
      "image",
      "copy",
      digestReference(source, digest),
      destination,
    ]);
    if (!copied.ok) {
      log(`::warning::native copy failed: ${source} -> ${destination}`);
      if (copied.stderr.trim() !== "") log(copied.stderr.trim());
      failed += 1;
      continue;
    }
    log(`mirrored ${destination}@${digest}`);
  }
  return failed;
};

export const nativesFromEvent = async (
  env: NodeJS.Dict<string>,
  version: string,
  readText: (path: string) => Promise<string>,
): Promise<ReadonlyArray<NativeArtifact>> => {
  if (envValue(env, "EVENT_NAME") !== "repository_dispatch") return [];
  const path = envValue(env, "GITHUB_EVENT_PATH").trim();
  if (path === "")
    throw new InvalidPayloadError("GITHUB_EVENT_PATH is required for repository_dispatch");
  const event: unknown = JSON.parse(await readText(path));
  const payload =
    typeof event === "object" && event !== null && "client_payload" in event
      ? (event as { client_payload?: { natives?: unknown } }).client_payload
      : undefined;
  return parseNatives(payload?.natives, version);
};

const defaultReadText = (path: string): Promise<string> => Bun.file(path).text();

const defaultSpawn: RunCommand = async (argv) => {
  const proc = Bun.spawn([...argv], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exit] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { ok: exit === 0, stdout, stderr };
};

export const main = async (argv: ReadonlyArray<string>, io: MirrorIo): Promise<number> => {
  const command = argv[0];
  const log = io.log ?? console.log;
  const readText = io.readText ?? defaultReadText;
  if (command === undefined || command === "-h" || command === "--help") {
    log(usage);
    return command === undefined ? 2 : 0;
  }
  if (command === "validate") {
    const refs = validateMirrorDispatch({
      eventName: envValue(io.env, "EVENT_NAME"),
      service: envValue(io.env, "SERVICE"),
      version: envValue(io.env, "VERSION"),
      digest: envValue(io.env, "DIGEST"),
      payloadSource: io.env["PAYLOAD_SOURCE"],
      payloadDestination: io.env["PAYLOAD_DESTINATION"],
    });
    writeGithubOutput(io.env, refs, io.writeOutput);
    return 0;
  }
  if (command === "verify-digest") {
    await verifyDigest({
      reference: requireEnv(io.env, "REFERENCE"),
      digest: requireEnv(io.env, "DIGEST"),
      run: io.run,
      log,
    });
    return 0;
  }
  if (command === "ensure-repo") {
    await ensureEcrPublicRepo({
      service: requireEnv(io.env, "SERVICE"),
      run: io.run,
      log,
    });
    return 0;
  }
  if (command === "copy-image") {
    await copyImage({
      source: requireEnv(io.env, "SOURCE"),
      destination: requireEnv(io.env, "DESTINATION"),
      digest: requireEnv(io.env, "DIGEST"),
      run: io.run,
    });
    return 0;
  }
  if (command === "copy-natives") {
    const service = requireEnv(io.env, "SERVICE");
    const version = requireEnv(io.env, "VERSION");
    const natives = await nativesFromEvent(io.env, version, readText);
    if (natives.length === 0) {
      log("no native artifacts in payload");
      return 0;
    }
    return await copyNatives({ service, natives, run: io.run, log });
  }
  log(usage);
  return 2;
};

if (import.meta.main) {
  try {
    const code = await main(process.argv.slice(2), { env: process.env, run: defaultSpawn });
    process.exit(code);
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    console.error(`::error::${message}`);
    process.exit(1);
  }
}
