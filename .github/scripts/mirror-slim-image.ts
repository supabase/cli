/**
 * GHCR → ECR Public copy for slim images and optional native OCI tags, plus the
 * GHCR → S3 copy of the native triplets. Registry logins and AWS credentials stay
 * in the workflow; this script is the replayable logic.
 *
 *   bun .github/scripts/mirror-slim-image.ts validate
 *   bun .github/scripts/mirror-slim-image.ts verify-digest
 *   bun .github/scripts/mirror-slim-image.ts ensure-repo
 *   bun .github/scripts/mirror-slim-image.ts copy-image
 *   bun .github/scripts/mirror-slim-image.ts copy-natives
 *   bun .github/scripts/mirror-slim-image.ts fetch-natives
 *   bun .github/scripts/mirror-slim-image.ts upload-natives-s3
 */

import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

import {
  DEST_REGISTRY,
  InvalidPayloadError,
  S3_BASE_URL,
  S3_BUCKET,
  SOURCE_REGISTRY,
  checksumFor,
  digestReference,
  manifestMatches,
  nativeFileNames,
  nativeObjectKey,
  nativeObjectUrl,
  nativeTargetOf,
  nativeTripletDigests,
  parseNatives,
  validateMirrorDispatch,
  type NativeArtifact,
  type NativeFiles,
} from "./slim-mirror-payload.ts";

export type CommandResult = {
  readonly ok: boolean;
  readonly stdout: string;
  readonly stderr: string;
};

export type RunCommand = (argv: ReadonlyArray<string>) => Promise<CommandResult>;

/** Like {@link RunCommand} but streams stdout into `outputPath`, for binary blobs. */
export type RunCommandToFile = (
  argv: ReadonlyArray<string>,
  outputPath: string,
) => Promise<CommandResult>;

export type MirrorIo = {
  readonly env: NodeJS.Dict<string>;
  readonly run: RunCommand;
  readonly runToFile?: RunCommandToFile;
  readonly log?: (message: string) => void;
  readonly readText?: (path: string) => Promise<string>;
  readonly sha256File?: (path: string) => Promise<string>;
  readonly httpStatus?: (url: string, method: "HEAD" | "GET") => Promise<number>;
  readonly mkdir?: (path: string) => void;
  readonly writeOutput?: (fields: Readonly<Record<string, string>>) => void;
};

const usage = `Usage:
  bun .github/scripts/mirror-slim-image.ts validate
  bun .github/scripts/mirror-slim-image.ts verify-digest
  bun .github/scripts/mirror-slim-image.ts ensure-repo
  bun .github/scripts/mirror-slim-image.ts copy-image
  bun .github/scripts/mirror-slim-image.ts copy-natives
  bun .github/scripts/mirror-slim-image.ts fetch-natives
  bun .github/scripts/mirror-slim-image.ts upload-natives-s3`;

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

export type FetchedNative = {
  readonly target: string;
  readonly files: NativeFiles;
};

/**
 * Pulls each native triplet from GHCR by digest into `<outputDir>/<target>/` under its
 * release asset names, then checks the archive against its own SHA256SUMS and the manifest
 * against the dispatch fields. Returns the targets that passed; failures are warnings.
 */
export const fetchNatives = async (options: {
  readonly service: string;
  readonly version: string;
  readonly natives: ReadonlyArray<NativeArtifact>;
  readonly outputDir: string;
  readonly run: RunCommand;
  readonly runToFile: RunCommandToFile;
  readonly readText: (path: string) => Promise<string>;
  readonly sha256File: (path: string) => Promise<string>;
  readonly mkdir: (path: string) => void;
  readonly log?: (message: string) => void;
}): Promise<ReadonlyArray<FetchedNative>> => {
  const log = options.log ?? console.log;
  const repository = `${SOURCE_REGISTRY}/${options.service}`;
  const fetched: FetchedNative[] = [];
  for (const { tag, digest } of options.natives) {
    const target = nativeTargetOf(tag, options.version);
    if (target === undefined) {
      log(`::warning::native tag ${tag} does not name a target`);
      continue;
    }
    // The digest is untrusted dispatch data: only publish what the tag currently points to.
    const source = `${repository}:${tag}`;
    const head = await options.run(["regctl", "manifest", "head", source]);
    if (!head.ok) {
      log(`::warning::native source ${source} is missing`);
      if (head.stderr.trim() !== "") log(head.stderr.trim());
      continue;
    }
    if (head.stdout.trim() !== digest) {
      log(
        `::warning::native source ${source} resolves to ${head.stdout.trim()}, expected ${digest}`,
      );
      continue;
    }
    const reference = `${repository}@${digest}`;
    const manifest = await options.run([
      "regctl",
      "manifest",
      "get",
      reference,
      "--format",
      "raw-body",
    ]);
    if (!manifest.ok) {
      log(`::warning::native manifest ${reference} is missing`);
      if (manifest.stderr.trim() !== "") log(manifest.stderr.trim());
      continue;
    }
    const digests = nativeTripletDigests(manifest.stdout);
    if (digests === undefined) {
      log(`::warning::native ${reference} is not a complete archive/manifest/checksum triplet`);
      continue;
    }
    const files = nativeFileNames(options.service, options.version, target);
    const dir = join(options.outputDir, target);
    options.mkdir(dir);
    let complete = true;
    for (const part of ["archive", "manifest", "checksum"] as const) {
      const blob = await options.runToFile(
        ["regctl", "blob", "get", repository, digests[part]],
        join(dir, files[part]),
      );
      if (!blob.ok) {
        log(`::warning::native blob ${digests[part]} for ${reference} failed to download`);
        if (blob.stderr.trim() !== "") log(blob.stderr.trim());
        complete = false;
        break;
      }
    }
    if (!complete) continue;
    const expected = checksumFor(await options.readText(join(dir, files.checksum)), files.archive);
    if (expected === undefined) {
      log(`::warning::${files.checksum} has no entry for ${files.archive}`);
      continue;
    }
    const actual = (await options.sha256File(join(dir, files.archive))).toLowerCase();
    if (actual !== expected) {
      log(`::warning::${files.archive} hashes to ${actual}, ${files.checksum} says ${expected}`);
      continue;
    }
    const matches = manifestMatches(await options.readText(join(dir, files.manifest)), {
      service: options.service,
      version: options.version,
      target,
    });
    if (!matches) {
      log(
        `::warning::${files.manifest} does not describe ${options.service} ${options.version} ${target}`,
      );
      continue;
    }
    log(`verified ${files.archive} from ${reference}`);
    fetched.push({ target, files });
  }
  return fetched;
};

const CONTENT_TYPES: Readonly<Record<keyof NativeFiles, string>> = {
  archive: "application/zstd",
  manifest: "application/json",
  checksum: "text/plain",
};

/**
 * Copies verified triplets to `s3://<bucket>/<service>/<version>/` with plain `aws s3 cp`
 * (the publisher role has PutObject only, so no `sync`), checksum last so a reader never
 * pairs a new sums file with an older archive for longer than the upload takes. Then checks
 * every object anonymously and that the bucket root still refuses listing.
 */
export const uploadNativesS3 = async (options: {
  readonly service: string;
  readonly version: string;
  readonly inputDir: string;
  readonly fetched: ReadonlyArray<FetchedNative>;
  readonly run: RunCommand;
  readonly httpStatus: (url: string, method: "HEAD" | "GET") => Promise<number>;
  readonly log?: (message: string) => void;
}): Promise<void> => {
  const log = options.log ?? console.log;
  const uploaded: string[] = [];
  for (const { target, files } of options.fetched) {
    for (const part of ["archive", "manifest", "checksum"] as const) {
      const key = nativeObjectKey(options.service, options.version, files[part]);
      const copied = await options.run([
        "aws",
        "s3",
        "cp",
        "--only-show-errors",
        "--content-type",
        CONTENT_TYPES[part],
        join(options.inputDir, target, files[part]),
        `s3://${S3_BUCKET}/${key}`,
      ]);
      if (!copied.ok)
        throw new InvalidPayloadError(
          copied.stderr.trim() || `upload failed: s3://${S3_BUCKET}/${key}`,
        );
      uploaded.push(files[part]);
    }
    log(`uploaded ${target} to s3://${S3_BUCKET}/${options.service}/${options.version}/`);
  }
  for (const fileName of uploaded) {
    const url = nativeObjectUrl(options.service, options.version, fileName);
    const status = await options.httpStatus(url, "HEAD");
    if (status !== 200)
      throw new InvalidPayloadError(`${url} is not publicly readable (HTTP ${status})`);
  }
  const listing = await options.httpStatus(`${S3_BASE_URL}/`, "GET");
  if (listing !== 403)
    throw new InvalidPayloadError(`bucket listing must stay closed, got HTTP ${listing}`);
  log(
    `${uploaded.length} objects readable at ${S3_BASE_URL}/${options.service}/${options.version}/`,
  );
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

const defaultSpawnToFile: RunCommandToFile = async (argv, outputPath) => {
  const proc = Bun.spawn([...argv], { stdout: "pipe", stderr: "pipe" });
  const [, stderr, exit] = await Promise.all([
    Bun.write(outputPath, new Response(proc.stdout)),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { ok: exit === 0, stdout: "", stderr };
};

const defaultSha256File = async (path: string): Promise<string> =>
  new Bun.CryptoHasher("sha256").update(await Bun.file(path).arrayBuffer()).digest("hex");

const defaultHttpStatus = async (url: string, method: "HEAD" | "GET"): Promise<number> =>
  (await fetch(url, { method, redirect: "manual" })).status;

const defaultMkdir = (path: string): void => {
  mkdirSync(path, { recursive: true });
};

const fetchedFromTargets = (service: string, version: string, targets: string): FetchedNative[] =>
  targets
    .split(",")
    .map((target) => target.trim())
    .filter((target) => target !== "")
    .map((target) => ({
      target,
      files: nativeFileNames(service, version, target),
    }));

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
  if (command === "fetch-natives") {
    const service = requireEnv(io.env, "SERVICE");
    const version = requireEnv(io.env, "VERSION");
    const outputDir = requireEnv(io.env, "OUTPUT_DIR");
    const natives = await nativesFromEvent(io.env, version, readText);
    const fetched =
      natives.length === 0
        ? []
        : await fetchNatives({
            service,
            version,
            natives,
            outputDir,
            run: io.run,
            runToFile: io.runToFile ?? defaultSpawnToFile,
            readText,
            sha256File: io.sha256File ?? defaultSha256File,
            mkdir: io.mkdir ?? defaultMkdir,
            log,
          });
    if (natives.length === 0) log("no native artifacts in payload");
    writeGithubOutput(
      io.env,
      {
        count: String(fetched.length),
        targets: fetched.map((item) => item.target).join(","),
      },
      io.writeOutput,
    );
    return natives.length > 0 && fetched.length === 0 ? 1 : 0;
  }
  if (command === "upload-natives-s3") {
    const service = requireEnv(io.env, "SERVICE");
    const version = requireEnv(io.env, "VERSION");
    await uploadNativesS3({
      service,
      version,
      inputDir: requireEnv(io.env, "INPUT_DIR"),
      fetched: fetchedFromTargets(service, version, requireEnv(io.env, "TARGETS")),
      run: io.run,
      httpStatus: io.httpStatus ?? defaultHttpStatus,
      log,
    });
    return 0;
  }
  log(usage);
  return 2;
};

if (import.meta.main) {
  try {
    const code = await main(process.argv.slice(2), {
      env: process.env,
      run: defaultSpawn,
    });
    process.exit(code);
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    console.error(`::error::${message}`);
    process.exit(1);
  }
}
