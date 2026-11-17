import { BunRuntime, BunServices } from "@effect/platform-bun";
import { Config, Effect, FileSystem, Option, Path, Redacted, Schema, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import {
  guidanceReviewStatus,
  isReferenceSource,
  type GuidanceManifest,
} from "./docs-guidance-status.ts";

export const GUIDE_PATHS = [
  "apps/docs/style-guide/README.md",
  "apps/docs/style-guide/01-voice-and-tone.md",
  "apps/docs/style-guide/02-elements.md",
  "apps/docs/style-guide/03-page-structure.md",
  "apps/docs/style-guide/WORD_LIST.md",
] as const;

export type GuidanceSnapshot = {
  status: GuidanceManifest["status"];
  sha: string | null;
  files: { path: string; content: string }[];
};

type Fetch = (url: string, init: RequestInit) => Promise<Response>;

class GuidanceError extends Schema.TaggedError<GuidanceError>()("GuidanceError", {
  operation: Schema.String,
}) {}

const Revision = Schema.Struct({
  object: Schema.Struct({
    type: Schema.Literal("commit"),
    sha: Schema.String.check(Schema.isPattern(/^[0-9a-f]{40}$/)),
  }),
});

const ManifestJson = Schema.fromJsonString(
  Schema.Struct({
    status: Schema.Literals(["available", "unavailable", "not-applicable"]),
    sha: Schema.NullOr(Schema.String),
    files: Schema.Array(Schema.Struct({ path: Schema.String, localPath: Schema.String })),
  }),
);

// The fetch adapter owns streaming byte limits, redirect refusal and whole-body cancellation.
const boundedText = Effect.fn("DocsGuidance.fetch")(function* (
  fetcher: Fetch,
  url: string,
  limit: number,
  headers: Record<string, string> = { Accept: "application/vnd.github+json" },
) {
  return yield* Effect.acquireUseRelease(
    Effect.sync(() => new AbortController()),
    (controller) =>
      Effect.gen(function* () {
        const response = yield* Effect.tryPromise({
          try: () =>
            fetcher(url, {
              signal: controller.signal,
              redirect: "error",
              headers,
            }),
          catch: () => new GuidanceError({ operation: "fetch" }),
        });
        if (!response.ok || !response.body) return yield* new GuidanceError({ operation: "http" });
        const reader = response.body.getReader();
        const chunks: Uint8Array[] = [];
        let size = 0;
        for (;;) {
          const { done, value } = yield* Effect.tryPromise({
            try: () => reader.read(),
            catch: () => new GuidanceError({ operation: "read" }),
          });
          if (done) break;
          size += value.byteLength;
          if (size > limit) return yield* new GuidanceError({ operation: "size" });
          chunks.push(value);
        }
        const bytes = new Uint8Array(size);
        let offset = 0;
        for (const chunk of chunks) {
          bytes.set(chunk, offset);
          offset += chunk.length;
        }
        return yield* Effect.try({
          try: () => new TextDecoder("utf-8", { fatal: true }).decode(bytes),
          catch: () => new GuidanceError({ operation: "utf8" }),
        });
      }).pipe(Effect.timeout("15 seconds")),
    (controller) => Effect.sync(() => controller.abort()),
  );
});

/** Authenticates the revision lookup when configured; retrieves pinned guides without credentials. */
export const collectGuidance = Effect.fn("DocsGuidance.collect")(function* (
  paths: readonly string[],
  fetcher: Fetch = fetch,
) {
  if (!paths.some(isReferenceSource)) {
    return { status: "not-applicable", sha: null, files: [] } satisfies GuidanceSnapshot;
  }
  let sha: string | null = null;
  return yield* Effect.gen(function* () {
    const token = yield* Config.option(Config.Redacted("GH_TOKEN"));
    const text = yield* boundedText(
      fetcher,
      "https://api.github.com/repos/supabase/supabase/git/ref/heads/master",
      64 * 1024,
      {
        Accept: "application/vnd.github+json",
        ...(Option.isSome(token) && Redacted.value(token.value)
          ? { Authorization: `Bearer ${Redacted.value(token.value)}` }
          : {}),
      },
    );
    const ref = yield* Schema.decodeEffect(Schema.fromJsonString(Revision))(text).pipe(
      Effect.mapError(() => new GuidanceError({ operation: "revision" })),
    );
    sha = ref.object.sha;
    const files = [];
    for (const path of GUIDE_PATHS) {
      const content = yield* boundedText(
        fetcher,
        `https://raw.githubusercontent.com/supabase/supabase/${sha}/${path}`,
        512 * 1024,
      );
      if (!content.trim()) return yield* new GuidanceError({ operation: "empty-file" });
      files.push({ path, content });
    }
    yield* Effect.annotateCurrentSpan({
      "guidance.status": "available",
      "guidance.files": files.length,
    });
    return { status: "available", sha, files } satisfies GuidanceSnapshot;
  }).pipe(
    Effect.orElseSucceed(
      () => ({ status: "unavailable", sha, files: [] }) satisfies GuidanceSnapshot,
    ),
  );
});

/** Writes readable reference files and commits the manifest only after all artifact inputs exist. */
export const writeGuidance = Effect.fn("DocsGuidance.writeArtifact")(function* (
  snapshot: GuidanceSnapshot,
  directory: string,
  procedurePath: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const guidesDirectory = path.join(directory, "docs-guidance");
  yield* fs.makeDirectory(directory, { recursive: true });
  yield* fs.remove(guidesDirectory, { recursive: true, force: true });
  const files: GuidanceManifest["files"] = [];
  for (const file of snapshot.files) {
    if (!GUIDE_PATHS.some((allowed) => allowed === file.path)) {
      return yield* new GuidanceError({ operation: "artifact-path" });
    }
    const localPath = `docs-guidance/${path.basename(file.path)}`;
    yield* fs.makeDirectory(guidesDirectory, { recursive: true });
    yield* fs.writeFileString(path.join(directory, localPath), file.content);
    files.push({ path: file.path, localPath });
  }
  yield* fs.copyFile(procedurePath, path.join(directory, "cli-reference-procedure.md"));
  const manifest: GuidanceManifest = { status: snapshot.status, sha: snapshot.sha, files };
  const json = yield* Schema.encodeEffect(ManifestJson)(manifest);
  yield* fs.writeFileString(path.join(directory, "docs-guidance.json"), `${json}\n`);
  yield* Effect.annotateCurrentSpan({
    "guidance.status": manifest.status,
    "guidance.files": files.length,
  });
  return manifest;
});

const changedPaths = Effect.fn("DocsGuidance.changedPaths")(function* () {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  return yield* Effect.scoped(
    Effect.gen(function* () {
      const child = yield* spawner.spawn(
        ChildProcess.make(
          "git",
          ["diff", "--name-only", "-z", "refs/ai-review/base...refs/ai-review/head", "--"],
          { stdin: "ignore", stderr: "ignore" },
        ),
      );
      const output = yield* child.stdout.pipe(Stream.decodeText, Stream.mkString);
      const exitCode = yield* child.exitCode;
      yield* Effect.annotateCurrentSpan({ "process.exit_code": exitCode });
      if (exitCode !== 0) return yield* new GuidanceError({ operation: "source-selection" });
      return output.split("\0").filter(Boolean);
    }),
  ).pipe(Effect.timeout("30 seconds"));
});

const main = Effect.fn("DocsGuidance.main")(function* () {
  const paths =
    process.argv[2] === "--paths" ? Effect.succeed(process.argv.slice(3)) : changedPaths();
  const snapshot = yield* paths.pipe(
    Effect.flatMap((paths) => collectGuidance(paths)),
    Effect.orElseSucceed(
      () => ({ status: "unavailable", sha: null, files: [] }) satisfies GuidanceSnapshot,
    ),
  );
  const manifest = yield* writeGuidance(
    snapshot,
    "/tmp/ai-review",
    ".agents/skills/cli-reference/review-procedure.md",
  );
  yield* Effect.log(guidanceReviewStatus(manifest));
});

if (import.meta.main) {
  main().pipe(Effect.provide(BunServices.layer), BunRuntime.runMain);
}
