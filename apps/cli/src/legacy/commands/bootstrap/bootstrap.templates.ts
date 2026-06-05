import { Context, Effect, FileSystem, Layer, Path } from "effect";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";

import { Output } from "../../../shared/output/output.service.ts";
import { sanitizeLegacyErrorBody } from "../../shared/legacy-http-errors.ts";
import {
  LegacyBootstrapTemplateDownloadError,
  LegacyBootstrapTemplateListError,
} from "./bootstrap.errors.ts";

export interface LegacyStarterTemplate {
  readonly name: string;
  readonly description: string;
  readonly url: string;
  readonly start: string;
}

interface LegacyTemplateServiceShape {
  /**
   * Fetches and decodes `samples.json` from the `supabase-community/supabase-samples`
   * repo (Go's `ListSamples`). Returns the declared starter templates.
   */
  readonly listSamples: Effect.Effect<
    ReadonlyArray<LegacyStarterTemplate>,
    LegacyBootstrapTemplateListError
  >;
  /**
   * Downloads every file under a `https://github.com/<owner>/<repo>/tree/<ref>/<root>`
   * template URL into `targetDir`, preserving the directory layout below `<root>`
   * (Go's `downloadSample`). Concurrency matches Go's job queue (5).
   */
  readonly download: (
    templateUrl: string,
    targetDir: string,
  ) => Effect.Effect<void, LegacyBootstrapTemplateDownloadError>;
}

export class LegacyTemplateService extends Context.Service<
  LegacyTemplateService,
  LegacyTemplateServiceShape
>()("supabase/legacy/TemplateService") {}

const GITHUB_API = "https://api.github.com";
const SAMPLES_OWNER = "supabase-community";
const SAMPLES_REPO = "supabase-samples";
const DOWNLOAD_CONCURRENCY = 5;

interface GithubContentEntry {
  readonly type?: string;
  readonly name?: string;
  readonly path?: string;
  readonly content?: string;
  readonly encoding?: string;
  readonly download_url?: string | null;
}

function isStarterTemplate(value: unknown): value is LegacyStarterTemplate {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as LegacyStarterTemplate).name === "string"
  );
}

// Preserve an explicit non-200 / parse failure (already a tagged error); wrap any
// transport / filesystem cause in the same tagged error so the channel stays narrow.
const mapDownloadError = (
  cause: unknown,
): Effect.Effect<never, LegacyBootstrapTemplateDownloadError> =>
  Effect.fail(
    cause instanceof LegacyBootstrapTemplateDownloadError
      ? cause
      : new LegacyBootstrapTemplateDownloadError({
          message: `failed to download template: ${cause}`,
        }),
  );

export const legacyTemplateServiceLayer = Layer.effect(
  LegacyTemplateService,
  Effect.gen(function* () {
    const httpClient = yield* HttpClient.HttpClient;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const output = yield* Output;

    // Go reads `GITHUB_TOKEN` directly (`utils.GetGitHubClient`) to raise the
    // anonymous GitHub API rate limit. When unset, requests are anonymous.
    const githubToken = process.env["GITHUB_TOKEN"];

    const contentsRequest = (owner: string, repo: string, contentPath: string, ref: string) => {
      const encodedPath = contentPath
        .split("/")
        .map((segment) => encodeURIComponent(segment))
        .join("/");
      let request = HttpClientRequest.get(
        `${GITHUB_API}/repos/${owner}/${repo}/contents/${encodedPath}?ref=${ref}`,
      ).pipe(HttpClientRequest.setHeader("Accept", "application/vnd.github.v3+json"));
      if (githubToken !== undefined && githubToken.length > 0) {
        request = request.pipe(
          HttpClientRequest.setHeader("Authorization", `Bearer ${githubToken}`),
        );
      }
      return request;
    };

    const listSamples: Effect.Effect<
      ReadonlyArray<LegacyStarterTemplate>,
      LegacyBootstrapTemplateListError
    > = Effect.gen(function* () {
      const response = yield* httpClient
        .execute(contentsRequest(SAMPLES_OWNER, SAMPLES_REPO, "samples.json", "main"))
        .pipe(
          Effect.mapError(
            (cause) =>
              new LegacyBootstrapTemplateListError({
                message: `failed to list samples: ${cause}`,
              }),
          ),
        );
      if (response.status !== 200) {
        const body = sanitizeLegacyErrorBody(
          yield* response.text.pipe(Effect.orElseSucceed(() => "")),
        );
        return yield* new LegacyBootstrapTemplateListError({
          message: `failed to list samples: status ${response.status}: ${body}`,
        });
      }
      const payload = yield* response.json.pipe(
        Effect.mapError(
          (cause) =>
            new LegacyBootstrapTemplateListError({ message: `failed to decode samples: ${cause}` }),
        ),
      );
      const decoded = Buffer.from(
        ((payload as GithubContentEntry).content ?? "").replaceAll("\n", ""),
        "base64",
      ).toString("utf8");
      const parsed = yield* Effect.try({
        try: () => JSON.parse(decoded) as { samples?: ReadonlyArray<unknown> },
        catch: (cause) =>
          new LegacyBootstrapTemplateListError({
            message: `failed to unmarshal samples: ${cause}`,
          }),
      });
      return (parsed.samples ?? []).filter(isStarterTemplate);
    });

    const downloadFile = (localPath: string, remoteUrl: string) =>
      Effect.gen(function* () {
        const response = yield* httpClient.execute(HttpClientRequest.get(remoteUrl));
        if (response.status !== 200) {
          return yield* new LegacyBootstrapTemplateDownloadError({
            message: `failed to download template: status ${response.status}`,
          });
        }
        const bytes = new Uint8Array(yield* response.arrayBuffer);
        yield* fs.makeDirectory(path.dirname(localPath), { recursive: true });
        yield* fs.writeFile(localPath, bytes);
      }).pipe(Effect.catch(mapDownloadError));

    const download = (templateUrl: string, targetDir: string) =>
      Effect.gen(function* () {
        // e.g. https://github.com/supabase/supabase/tree/master/examples/user-management
        const parsed = new URL(templateUrl);
        const parts = parsed.pathname.split("/");
        const owner = parts[1] ?? "";
        const repo = parts[2] ?? "";
        const ref = parts[4] ?? "";
        const root = parts.slice(5).join("/");

        const downloads: Array<{ readonly localPath: string; readonly remoteUrl: string }> = [];
        const queue: Array<string> = [root];
        while (queue.length > 0) {
          const contentPath = queue.shift() ?? "";
          const response = yield* httpClient.execute(
            contentsRequest(owner, repo, contentPath, ref),
          );
          if (response.status !== 200) {
            const body = sanitizeLegacyErrorBody(
              yield* response.text.pipe(Effect.orElseSucceed(() => "")),
            );
            return yield* new LegacyBootstrapTemplateDownloadError({
              message: `failed to download template: status ${response.status}: ${body}`,
            });
          }
          const payload = yield* response.json;
          if (!Array.isArray(payload)) {
            return yield* new LegacyBootstrapTemplateDownloadError({
              message: `failed to download template: expected a directory listing for ${contentPath}`,
            });
          }
          const listing = payload as ReadonlyArray<GithubContentEntry>;
          for (const entry of listing) {
            const entryPath = entry.path ?? "";
            if (entry.type === "file") {
              // Strip `<root>` on a path-segment boundary so a sibling directory that
              // merely shares the prefix (e.g. `examples/app-2` under `root="examples/app"`)
              // is never mis-sliced. The contents API only returns children of the queried
              // directory, but matching on `root + "/"` is the obviously-correct form.
              const relative =
                root === ""
                  ? entryPath
                  : entryPath === root
                    ? ""
                    : entryPath.startsWith(`${root}/`)
                      ? entryPath.slice(root.length + 1)
                      : entryPath;
              const localPath = path.join(targetDir, ...relative.split("/").filter(Boolean));
              // Defence-in-depth: reject a malicious `path` (e.g. `../../etc/x`)
              // that would escape the target directory.
              const resolvedTarget = path.resolve(targetDir);
              const resolvedLocal = path.resolve(localPath);
              if (
                resolvedLocal !== resolvedTarget &&
                !resolvedLocal.startsWith(resolvedTarget + path.sep)
              ) {
                return yield* new LegacyBootstrapTemplateDownloadError({
                  message: `failed to download template: entry escapes target directory: ${entryPath}`,
                });
              }
              // GitHub returns a null `download_url` for files over 1 MB and for
              // submodules; without an explicit guard the `?? ""` fallback would issue
              // `GET ""` and surface a confusing transport error instead of a clear one.
              if (entry.download_url == null || entry.download_url.length === 0) {
                return yield* new LegacyBootstrapTemplateDownloadError({
                  message: `failed to download template: unsupported entry (no download URL): ${entryPath}`,
                });
              }
              downloads.push({ localPath, remoteUrl: entry.download_url });
            } else if (entry.type === "dir") {
              queue.push(entryPath);
            } else {
              yield* output.raw(`Ignoring ${entry.type}: ${entryPath}\n`, "stderr");
            }
          }
        }

        yield* Effect.forEach(downloads, (job) => downloadFile(job.localPath, job.remoteUrl), {
          concurrency: DOWNLOAD_CONCURRENCY,
        });
      }).pipe(Effect.catch(mapDownloadError));

    return { listSamples, download };
  }),
);
