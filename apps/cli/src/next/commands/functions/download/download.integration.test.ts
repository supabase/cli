import { describe, expect, it } from "@effect/vitest";
import { FunctionResponse, makeApiClient } from "@supabase/api/effect";
import { dockerfileServiceImage } from "../../../../shared/services/dockerfile-images.ts";
import { existsSync, mkdtempSync } from "node:fs";
import { mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Layer, Option, Stdio } from "effect";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientError from "effect/unstable/http/HttpClientError";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";
import type * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import { PlatformApi } from "../../../auth/platform-api.service.ts";
import {
  ProjectNotLinkedError,
  type ProjectLinkStateValue,
} from "../../../config/project-link-state.service.ts";
import { ProjectHome } from "../../../config/project-home.service.ts";
import { LegacyGoProxy } from "../../../../shared/legacy/go-proxy.service.ts";
import { withJsonErrorHandling } from "../../../../shared/output/json-error-handling.ts";
import {
  emptyEnv,
  mockOutput,
  mockProjectLinkState,
  mockRuntimeInfo,
} from "../../../../../tests/helpers/mocks.ts";
import { mockChildProcessSpawner } from "../../../../../../../packages/process-compose/tests/helpers/mocks.ts";
import type { FunctionsDownloadFlags } from "./download.command.ts";
import {
  ConflictingFunctionDownloadFlagsError,
  InvalidFunctionDownloadResponseError,
  InvalidFunctionSlugError,
  UnsafeFunctionDownloadPathError,
} from "../../../../shared/functions/download.errors.ts";
import { invalidFunctionSlugDetail } from "../../../../shared/functions/functions.shared.ts";
import { functionsDownload } from "./download.handler.ts";

const PROJECT_REF = "abcdefghijklmnopqrst";
const BRANCH_REF = "branchrefabcdefghij";
type ResponseBody = string | Blob;

const LINK_STATE: ProjectLinkStateValue = {
  project: {
    ref: PROJECT_REF,
    name: "Linked Project",
    organization_id: "org-id",
    organization_slug: "org-slug",
  },
  active_branch: {
    ref: BRANCH_REF,
    name: "main",
    is_default: true,
  },
  fetchedAt: "2026-01-01T00:00:00.000Z",
  versions: {},
};

const BASE_FLAGS: FunctionsDownloadFlags = {
  functionName: Option.some("hello-world"),
  projectRef: Option.none(),
  useApi: false,
  useDocker: false,
  legacyBundle: false,
};

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), "supabase-functions-download-"));
}

async function writeCliConfig(cwd: string) {
  await mkdir(join(cwd, "supabase"), { recursive: true });
  await writeFile(join(cwd, "supabase", "config.toml"), "");
}

function textResponse(
  request: HttpClientRequest.HttpClientRequest,
  status: number,
  body: ResponseBody = "",
  contentType = "text/plain",
  extraHeaders: Readonly<Record<string, string>> = {},
): HttpClientResponse.HttpClientResponse {
  return HttpClientResponse.fromWeb(
    request,
    new Response(body, {
      status,
      headers: {
        "content-type": contentType,
        ...extraHeaders,
      },
    }),
  );
}

function jsonResponse(
  request: HttpClientRequest.HttpClientRequest,
  status: number,
  body: unknown,
): HttpClientResponse.HttpClientResponse {
  return HttpClientResponse.fromWeb(
    request,
    new Response(JSON.stringify(body), {
      status,
      headers: {
        "content-type": "application/json",
      },
    }),
  );
}

function transportFailure(
  request: HttpClientRequest.HttpClientRequest,
  error: Error,
): HttpClientError.HttpClientError {
  return new HttpClientError.HttpClientError({
    reason: new HttpClientError.TransportError({
      request,
      cause: error,
      description: error.message,
    }),
  });
}

function multipartBody(parts: Array<{ headers: Record<string, string>; body: string }>) {
  const boundary = "supabase-test-boundary";
  const body = [
    ...parts.map((part) => {
      const headers = Object.entries(part.headers)
        .map(([key, value]) => `${key}: ${value}`)
        .join("\r\n");
      return `--${boundary}\r\n${headers}\r\n\r\n${part.body}\r\n`;
    }),
    `--${boundary}--\r\n`,
  ].join("");

  return {
    body,
    contentType: `multipart/form-data; boundary=${boundary}`,
  };
}

function binaryMultipartBody(parts: Array<{ headers: Record<string, string>; body: Uint8Array }>) {
  const boundary = "supabase-binary-boundary";
  const encoder = new TextEncoder();
  const chunks = parts.flatMap((part) => {
    const headers = Object.entries(part.headers)
      .map(([key, value]) => `${key}: ${value}`)
      .join("\r\n");
    return [
      encoder.encode(`--${boundary}\r\n${headers}\r\n\r\n`),
      part.body,
      encoder.encode("\r\n"),
    ];
  });
  chunks.push(encoder.encode(`--${boundary}--\r\n`));

  return {
    body: new Blob(chunks),
    contentType: `multipart/form-data; boundary=${boundary}`,
  };
}

function makeFunction(
  overrides: Partial<typeof FunctionResponse.Type> = {},
): typeof FunctionResponse.Type {
  return {
    id: "function-id",
    slug: "hello-world",
    name: "Hello World",
    status: "ACTIVE",
    version: 2,
    created_at: 1_687_423_025_152,
    updated_at: 1_687_423_025_152,
    verify_jwt: true,
    import_map: true,
    entrypoint_path: "functions/hello-world/index.ts",
    import_map_path: "functions/hello-world/deno.json",
    ...overrides,
  };
}

function mockDownloadApi(opts: {
  list?: ReadonlyArray<typeof FunctionResponse.Type>;
  listStatus?: number;
  listBody?: unknown;
  listError?: Error;
  functionBySlug?: Readonly<Record<string, typeof FunctionResponse.Type>>;
  functionStatusBySlug?: Readonly<Record<string, number>>;
  functionBodyBySlug?: Readonly<Record<string, unknown>>;
  bodyBySlug?: Readonly<
    Record<
      string,
      {
        status?: number;
        body: ResponseBody;
        contentType: string;
        headers?: Readonly<Record<string, string>>;
      }
    >
  >;
  bodyErrorBySlug?: Readonly<Record<string, Error>>;
}) {
  const requests: string[] = [];
  const acceptHeaders: Array<string | undefined> = [];

  const layer = Layer.effect(
    PlatformApi,
    makeApiClient({
      baseUrl: "https://api.supabase.com",
      accessToken: "test-token",
      userAgent: "supabase",
      headers: {
        "X-Supabase-Command": "functions download",
        "X-Supabase-Command-Run-ID": "run-123",
      },
    }),
  ).pipe(
    Layer.provide(
      Layer.succeed(
        HttpClient.HttpClient,
        HttpClient.make((request) => {
          requests.push(request.url);
          acceptHeaders.push(request.headers.accept);
          const url = new URL(request.url);
          if (url.pathname === `/v1/projects/${PROJECT_REF}/functions`) {
            if (opts.listError !== undefined) {
              return Effect.fail(transportFailure(request, opts.listError));
            }
            return Effect.succeed(
              jsonResponse(request, opts.listStatus ?? 200, opts.listBody ?? opts.list ?? []),
            );
          }

          const bodyMatch = url.pathname.match(
            new RegExp(`^/v1/projects/${PROJECT_REF}/functions/([^/]+)/body$`),
          );
          if (bodyMatch?.[1] !== undefined) {
            const slug = decodeURIComponent(bodyMatch[1]);
            const responseError = opts.bodyErrorBySlug?.[slug];
            if (responseError !== undefined) {
              return Effect.fail(transportFailure(request, responseError));
            }
            const response = opts.bodyBySlug?.[slug];
            return Effect.succeed(
              textResponse(
                request,
                response?.status ?? 200,
                response?.body ?? "",
                response?.contentType ?? "multipart/form-data; boundary=missing",
                response?.headers ?? {},
              ),
            );
          }

          const functionMatch = url.pathname.match(
            new RegExp(`^/v1/projects/${PROJECT_REF}/functions/([^/]+)$`),
          );
          if (functionMatch?.[1] !== undefined) {
            const slug = decodeURIComponent(functionMatch[1]);
            return Effect.succeed(
              jsonResponse(
                request,
                opts.functionStatusBySlug?.[slug] ?? 200,
                opts.functionBodyBySlug?.[slug] ??
                  opts.functionBySlug?.[slug] ??
                  makeFunction({ slug }),
              ),
            );
          }

          return Effect.succeed(textResponse(request, 404, "not found"));
        }),
      ),
    ),
  );

  return {
    layer,
    get requests() {
      return requests;
    },
    get acceptHeaders() {
      return acceptHeaders;
    },
  };
}

function setup(
  cwd: string,
  opts: Parameters<typeof mockDownloadApi>[0] & {
    format?: "text" | "json" | "stream-json";
    linked?: boolean;
    projectRoot?: string;
    rawArgs?: ReadonlyArray<string>;
    childLayer?: ReturnType<typeof mockChildProcessSpawner>["layer"];
  } = {},
) {
  const out = mockOutput({ format: opts.format ?? "text", interactive: false });
  const api = mockDownloadApi(opts);
  const proxy = mockLegacyGoProxy();
  const layer = Layer.mergeAll(
    emptyEnv(),
    out.layer,
    api.layer,
    proxy.layer,
    mockRuntimeInfo({ cwd }),
    mockProjectLinkState(opts.linked === false ? undefined : LINK_STATE),
    mockProjectHome(opts.projectRoot ?? cwd),
    Stdio.layerTest({
      args: Effect.succeed(opts.rawArgs ?? ["functions", "download"]),
    }),
    // Overrides `emptyEnv()`'s real `ChildProcessSpawner` (via `BunServices`)
    // so `--use-docker`'s now-default-true native path never spawns a real
    // `docker` process — CLI-1963.
    opts.childLayer ?? mockChildProcessSpawner({ exitCode: 0 }).layer,
  );

  return { out, api, layer, proxy };
}

function mockLegacyGoProxy() {
  const calls: string[][] = [];
  const captureCalls: string[][] = [];
  return {
    layer: Layer.succeed(LegacyGoProxy, {
      exec: (args: ReadonlyArray<string>) =>
        Effect.sync(() => {
          calls.push([...args]);
        }),
      execCapture: (args: ReadonlyArray<string>) =>
        Effect.sync(() => {
          captureCalls.push([...args]);
          return "";
        }),
    }),
    get calls() {
      return calls;
    },
    get captureCalls() {
      return captureCalls;
    },
  };
}

function mockProjectHome(projectRoot: string) {
  const projectHomeDir = join(projectRoot, ".supabase");
  return Layer.succeed(
    ProjectHome,
    ProjectHome.of({
      projectRoot,
      supabaseDir: join(projectRoot, "supabase"),
      projectHomeDir,
      projectLinkPath: join(projectHomeDir, "project.json"),
      projectLocalVersionsPath: join(projectHomeDir, "local-versions.json"),
      ensureProjectHomeDir: Effect.void,
    }),
  );
}

describe("functions download", () => {
  it.live("downloads a function from the linked project using multipart metadata", () => {
    const tempDir = makeTempDir();
    const multipart = multipartBody([
      {
        headers: {
          "Content-Disposition": 'form-data; name="metadata"',
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ deno2_entrypoint_path: "source/index.ts" }),
      },
      {
        headers: {
          "Content-Disposition": 'form-data; name="file"; filename="source/index.ts"',
        },
        body: "console.log('hello')",
      },
      {
        headers: {
          "Content-Disposition": 'form-data; name="file"; filename="source/utils.ts"',
        },
        body: "export const value = 1;",
      },
    ]);

    return Effect.gen(function* () {
      yield* Effect.tryPromise(() => writeCliConfig(tempDir));
      const { out, api, layer } = setup(tempDir, {
        bodyBySlug: {
          "hello-world": multipart,
        },
      });

      yield* functionsDownload(BASE_FLAGS).pipe(Effect.provide(layer));

      expect(api.requests).toContain(
        "https://api.supabase.com/v1/projects/abcdefghijklmnopqrst/functions/hello-world/body",
      );
      expect(api.acceptHeaders).toContain("multipart/form-data");
      expect(
        yield* Effect.tryPromise(() =>
          readFile(join(tempDir, "supabase", "functions", "hello-world", "index.ts"), "utf8"),
        ),
      ).toBe("console.log('hello')");
      expect(
        yield* Effect.tryPromise(() =>
          readFile(join(tempDir, "supabase", "functions", "hello-world", "utils.ts"), "utf8"),
        ),
      ).toBe("export const value = 1;");
      expect(out.stderrText).toContain("Downloading Function: hello-world\n");
      expect(out.stderrText).toContain(
        `Extracting file: ${join(tempDir, "supabase", "functions", "hello-world", "index.ts")}\n`,
      );
      expect(out.stderrText).toContain(
        `Downloaded Function hello-world from project abcdefghijklmnopqrst.\n`,
      );
    }).pipe(
      Effect.ensuring(Effect.tryPromise(() => rm(tempDir, { recursive: true, force: true }))),
    );
  });

  it.live("downloads multipart file parts under any field name", () => {
    const tempDir = makeTempDir();
    const multipart = multipartBody([
      {
        headers: {
          "Content-Disposition": 'form-data; name="metadata"',
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ deno2_entrypoint_path: "source/index.ts" }),
      },
      {
        headers: {
          "Content-Disposition": 'form-data; name="source"; filename="source/index.ts"',
        },
        body: "console.log('source')",
      },
    ]);

    return Effect.gen(function* () {
      yield* Effect.tryPromise(() => writeCliConfig(tempDir));
      const { layer } = setup(tempDir, {
        bodyBySlug: {
          "hello-world": multipart,
        },
      });

      yield* functionsDownload(BASE_FLAGS).pipe(Effect.provide(layer));

      expect(
        yield* Effect.tryPromise(() =>
          readFile(join(tempDir, "supabase", "functions", "hello-world", "index.ts"), "utf8"),
        ),
      ).toBe("console.log('source')");
    }).pipe(
      Effect.ensuring(Effect.tryPromise(() => rm(tempDir, { recursive: true, force: true }))),
    );
  });

  it.live(
    "falls back to function metadata when multipart metadata has an empty entrypoint path",
    () => {
      const tempDir = makeTempDir();
      const absoluteEntrypoint = "/tmp/functions-download-empty/source/index.ts";
      const multipart = multipartBody([
        {
          headers: {
            "Content-Disposition": 'form-data; name="metadata"',
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ deno2_entrypoint_path: "" }),
        },
        {
          headers: {
            "Content-Disposition": `form-data; name="file"; filename="${absoluteEntrypoint}"`,
          },
          body: "console.log('empty metadata')",
        },
      ]);

      return Effect.gen(function* () {
        yield* Effect.tryPromise(() => writeCliConfig(tempDir));
        const { layer } = setup(tempDir, {
          functionBySlug: {
            "hello-world": makeFunction({
              slug: "hello-world",
              entrypoint_path: `file://${absoluteEntrypoint}`,
            }),
          },
          bodyBySlug: {
            "hello-world": multipart,
          },
        });

        yield* functionsDownload(BASE_FLAGS).pipe(Effect.provide(layer));

        expect(
          yield* Effect.tryPromise(() =>
            readFile(join(tempDir, "supabase", "functions", "hello-world", "index.ts"), "utf8"),
          ),
        ).toBe("console.log('empty metadata')");
        expect(
          existsSync(join(tempDir, "supabase", "functions", "hello-world", "source", "index.ts")),
        ).toBe(false);
      }).pipe(
        Effect.ensuring(Effect.tryPromise(() => rm(tempDir, { recursive: true, force: true }))),
      );
    },
  );

  it.live("downloads into the linked project root when run from a subdirectory", () => {
    const tempDir = makeTempDir();
    const subdirectory = join(tempDir, "nested", "directory");
    const multipart = multipartBody([
      {
        headers: {
          "Content-Disposition": 'form-data; name="metadata"',
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ deno2_entrypoint_path: "source/index.ts" }),
      },
      {
        headers: {
          "Content-Disposition": 'form-data; name="file"; filename="source/index.ts"',
        },
        body: "console.log('hello')",
      },
    ]);

    return Effect.gen(function* () {
      yield* Effect.tryPromise(() => mkdir(subdirectory, { recursive: true }));
      const { layer } = setup(subdirectory, {
        projectRoot: tempDir,
        bodyBySlug: {
          "hello-world": multipart,
        },
      });

      yield* functionsDownload(BASE_FLAGS).pipe(Effect.provide(layer));

      expect(
        yield* Effect.tryPromise(() =>
          readFile(join(tempDir, "supabase", "functions", "hello-world", "index.ts"), "utf8"),
        ),
      ).toBe("console.log('hello')");
      expect(existsSync(join(subdirectory, "supabase", "functions"))).toBe(false);
    }).pipe(
      Effect.ensuring(Effect.tryPromise(() => rm(tempDir, { recursive: true, force: true }))),
    );
  });

  it.live("preserves binary file bytes from multipart responses", () => {
    const tempDir = makeTempDir();
    const binary = new Uint8Array([0, 255, 128, 13, 10, 45, 45, 1]);
    const multipart = binaryMultipartBody([
      {
        headers: {
          "Content-Disposition": 'form-data; name="metadata"',
          "Content-Type": "application/json",
        },
        body: new TextEncoder().encode(
          JSON.stringify({ deno2_entrypoint_path: "source/index.ts" }),
        ),
      },
      {
        headers: {
          "Content-Disposition": 'form-data; name="file"; filename="source/asset.bin"',
        },
        body: binary,
      },
    ]);

    return Effect.gen(function* () {
      yield* Effect.tryPromise(() => writeCliConfig(tempDir));
      const { layer } = setup(tempDir, {
        bodyBySlug: {
          "hello-world": multipart,
        },
      });

      yield* functionsDownload(BASE_FLAGS).pipe(Effect.provide(layer));

      expect(
        new Uint8Array(
          yield* Effect.tryPromise(() =>
            readFile(join(tempDir, "supabase", "functions", "hello-world", "asset.bin")),
          ),
        ),
      ).toEqual(binary);
    }).pipe(
      Effect.ensuring(Effect.tryPromise(() => rm(tempDir, { recursive: true, force: true }))),
    );
  });

  it.live(
    "falls back to function metadata when multipart metadata omits the entrypoint path",
    () => {
      const tempDir = makeTempDir();
      const absoluteEntrypoint = "/tmp/functions-download-abs/My Project/source/index.ts";
      const absoluteUtil = "/tmp/functions-download-abs/My Project/source/lib/utils.ts";
      const multipart = multipartBody([
        {
          headers: {
            "Content-Disposition": 'form-data; name="metadata"',
            "Content-Type": "application/json",
          },
          body: JSON.stringify({}),
        },
        {
          headers: {
            "Content-Disposition": `form-data; name="file"; filename="${absoluteEntrypoint}"`,
          },
          body: "console.log('abs')",
        },
        {
          headers: {
            "Content-Disposition": `form-data; name="file"; filename="${absoluteUtil}"`,
          },
          body: "export const util = 2;",
        },
      ]);

      return Effect.gen(function* () {
        yield* Effect.tryPromise(() => writeCliConfig(tempDir));
        const { layer } = setup(tempDir, {
          functionBySlug: {
            "hello-world": makeFunction({
              slug: "hello-world",
              entrypoint_path: `file://${absoluteEntrypoint.replaceAll(" ", "%20")}`,
            }),
          },
          bodyBySlug: {
            "hello-world": multipart,
          },
        });

        yield* functionsDownload(BASE_FLAGS).pipe(Effect.provide(layer));

        expect(
          yield* Effect.tryPromise(() =>
            readFile(join(tempDir, "supabase", "functions", "hello-world", "index.ts"), "utf8"),
          ),
        ).toBe("console.log('abs')");
        expect(
          yield* Effect.tryPromise(() =>
            readFile(
              join(tempDir, "supabase", "functions", "hello-world", "lib", "utils.ts"),
              "utf8",
            ),
          ),
        ).toBe("export const util = 2;");
      }).pipe(
        Effect.ensuring(Effect.tryPromise(() => rm(tempDir, { recursive: true, force: true }))),
      );
    },
  );

  it.live("downloads every function when no name is provided", () => {
    const tempDir = makeTempDir();
    const helloBody = multipartBody([
      {
        headers: {
          "Content-Disposition": 'form-data; name="metadata"',
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ deno2_entrypoint_path: "source/index.ts" }),
      },
      {
        headers: {
          "Content-Disposition": 'form-data; name="file"; filename="source/index.ts"',
        },
        body: "console.log('hello')",
      },
    ]);
    const byeBody = multipartBody([
      {
        headers: {
          "Content-Disposition": 'form-data; name="metadata"',
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ deno2_entrypoint_path: "source/index.ts" }),
      },
      {
        headers: {
          "Content-Disposition": 'form-data; name="file"; filename="source/index.ts"',
        },
        body: "console.log('bye')",
      },
    ]);

    return Effect.gen(function* () {
      yield* Effect.tryPromise(() => writeCliConfig(tempDir));
      const { out, layer } = setup(tempDir, {
        list: [
          makeFunction({ slug: "hello-world", name: "Hello World" }),
          makeFunction({ slug: "goodbye-world", name: "Goodbye World" }),
        ],
        bodyBySlug: {
          "hello-world": helloBody,
          "goodbye-world": byeBody,
        },
      });

      yield* functionsDownload({
        ...BASE_FLAGS,
        functionName: Option.none(),
      }).pipe(Effect.provide(layer));

      expect(
        yield* Effect.tryPromise(() =>
          readFile(join(tempDir, "supabase", "functions", "hello-world", "index.ts"), "utf8"),
        ),
      ).toBe("console.log('hello')");
      expect(
        yield* Effect.tryPromise(() =>
          readFile(join(tempDir, "supabase", "functions", "goodbye-world", "index.ts"), "utf8"),
        ),
      ).toBe("console.log('bye')");
      expect(out.stderrText).toContain("Found 2 function(s) to download\n");
      expect(out.stderrText).toContain(
        "Successfully downloaded all functions from project abcdefghijklmnopqrst\n",
      );
    }).pipe(
      Effect.ensuring(Effect.tryPromise(() => rm(tempDir, { recursive: true, force: true }))),
    );
  });

  it.live("rejects a malicious remote slug from download-all before any per-slug work", () => {
    const tempDir = makeTempDir();
    // Mirrors Go's own `TestDownloadAllRejectsMaliciousSlug` regression test
    // (`apps/cli-go/internal/functions/download/download_test.go`) — a
    // path-traversal-shaped slug returned by the (untrusted) list endpoint.
    const maliciousSlug = "../../../../../poc-escaped-outside-project";

    return Effect.gen(function* () {
      yield* Effect.tryPromise(() => writeCliConfig(tempDir));
      const { api, layer } = setup(tempDir, {
        list: [makeFunction({ slug: maliciousSlug })],
      });

      // CLI-1891 (Go parity): every slug sourced from the Management API's
      // function list must be validated before any per-slug network or
      // filesystem work — not just user-supplied CLI arguments.
      const error = yield* functionsDownload({
        ...BASE_FLAGS,
        functionName: Option.none(),
      }).pipe(Effect.provide(layer), Effect.flip);

      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toBe(
        `failed to download function ${maliciousSlug}: ${invalidFunctionSlugDetail}`,
      );
      expect((error as Error & { suggestion?: string }).suggestion).toBe(
        `The Supabase API returned an unexpected function slug (${maliciousSlug}). Retry the command, and if this keeps happening, verify your network connection is not being intercepted before contacting Supabase support.`,
      );
      // Only the list call happened — no GET to the malicious slug's own
      // body/metadata endpoints, and nothing was written to disk.
      expect(api.requests).toEqual([
        `https://api.supabase.com/v1/projects/${PROJECT_REF}/functions`,
      ]);
      expect(existsSync(join(tempDir, "supabase", "functions"))).toBe(false);
    }).pipe(
      Effect.ensuring(Effect.tryPromise(() => rm(tempDir, { recursive: true, force: true }))),
    );
  });

  it.live(
    "fails the whole list before downloading anything when a slug is typed as a non-string",
    () => {
      const tempDir = makeTempDir();

      return Effect.gen(function* () {
        yield* Effect.tryPromise(() => writeCliConfig(tempDir));
        // Go's generated client unmarshals the whole `[]FunctionResponse`
        // array in one `json.Unmarshal` call
        // (`apps/cli-go/pkg/api/client.gen.go:22186-22208`); a type mismatch
        // on any single element's `slug` (a required `string` field) fails
        // that call outright, so `downloadAll` fails with "failed to list
        // functions: ..." before downloading anything — including the
        // earlier, well-formed "ok" entry. Confirmed empirically:
        // `json.Unmarshal([]byte(`[{"slug":"ok"},{"slug":123}]`), &dest)`
        // returns a `*json.UnmarshalTypeError`, and the generated parser
        // returns before ever assigning `response.JSON200`.
        const { api, layer } = setup(tempDir, {
          listBody: [{ slug: "ok" }, { slug: 123 }],
        });

        const error = yield* functionsDownload({
          ...BASE_FLAGS,
          functionName: Option.none(),
        }).pipe(Effect.provide(layer), Effect.flip);

        expect(error).toBeInstanceOf(InvalidFunctionDownloadResponseError);
        expect((error as Error).message).toBe(
          "failed to read functions list: expected function slug to be a string, got number",
        );
        // Only the list call happened — "ok" was never downloaded, matching
        // Go's atomic list-decode failure instead of downloading it before
        // hitting the later entry's error.
        expect(api.requests).toEqual([
          `https://api.supabase.com/v1/projects/${PROJECT_REF}/functions`,
        ]);
        expect(existsSync(join(tempDir, "supabase", "functions"))).toBe(false);
      }).pipe(
        Effect.ensuring(Effect.tryPromise(() => rm(tempDir, { recursive: true, force: true }))),
      );
    },
  );

  it.live("prints the download-all success line when the project has one function", () => {
    const tempDir = makeTempDir();
    const multipart = multipartBody([
      {
        headers: {
          "Content-Disposition": 'form-data; name="metadata"',
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ deno2_entrypoint_path: "source/index.ts" }),
      },
      {
        headers: {
          "Content-Disposition": 'form-data; name="file"; filename="source/index.ts"',
        },
        body: "console.log('hello')",
      },
    ]);

    return Effect.gen(function* () {
      yield* Effect.tryPromise(() => writeCliConfig(tempDir));
      const { out, layer } = setup(tempDir, {
        list: [makeFunction({ slug: "hello-world" })],
        bodyBySlug: {
          "hello-world": multipart,
        },
      });

      yield* functionsDownload({
        ...BASE_FLAGS,
        functionName: Option.none(),
      }).pipe(Effect.provide(layer));

      expect(out.stderrText).toContain(
        "Successfully downloaded all functions from project abcdefghijklmnopqrst\n",
      );
    }).pipe(
      Effect.ensuring(Effect.tryPromise(() => rm(tempDir, { recursive: true, force: true }))),
    );
  });

  it.live("uses --use-api without delegating to the Go proxy", () => {
    const tempDir = makeTempDir();
    const multipart = multipartBody([
      {
        headers: {
          "Content-Disposition": 'form-data; name="metadata"',
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ deno2_entrypoint_path: "source/index.ts" }),
      },
      {
        headers: {
          "Content-Disposition": 'form-data; name="file"; filename="source/index.ts"',
        },
        body: "console.log('hello')",
      },
    ]);

    return Effect.gen(function* () {
      yield* Effect.tryPromise(() => writeCliConfig(tempDir));
      const { layer, proxy } = setup(tempDir, {
        bodyBySlug: {
          "hello-world": multipart,
        },
        rawArgs: ["functions", "download", "hello-world", "--use-api"],
      });

      yield* functionsDownload({
        ...BASE_FLAGS,
        useApi: true,
      }).pipe(Effect.provide(layer));

      expect(proxy.calls).toEqual([]);
    }).pipe(
      Effect.ensuring(Effect.tryPromise(() => rm(tempDir, { recursive: true, force: true }))),
    );
  });

  it.live("delegates --legacy-bundle with the linked project ref to the Go proxy", () => {
    const tempDir = makeTempDir();

    return Effect.gen(function* () {
      yield* Effect.tryPromise(() => writeCliConfig(tempDir));
      const { layer, proxy } = setup(tempDir, {
        rawArgs: ["functions", "download", "hello-world", "--legacy-bundle"],
      });

      yield* functionsDownload({
        ...BASE_FLAGS,
        legacyBundle: true,
      }).pipe(Effect.provide(layer));

      expect(proxy.calls).toEqual([
        ["functions", "download", "hello-world", "--project-ref", PROJECT_REF, "--legacy-bundle"],
      ]);
    }).pipe(
      Effect.ensuring(Effect.tryPromise(() => rm(tempDir, { recursive: true, force: true }))),
    );
  });

  it.live(
    "runs the native Docker unbundle path for --use-docker with the linked project ref",
    () => {
      const tempDir = makeTempDir();
      const child = mockChildProcessSpawner({ exitCode: 0 });

      return Effect.gen(function* () {
        yield* Effect.tryPromise(() => writeCliConfig(tempDir));
        const { out, layer, proxy } = setup(tempDir, {
          bodyBySlug: {
            "hello-world": { body: "fake-eszip-bytes", contentType: "application/octet-stream" },
          },
          rawArgs: ["functions", "download", "hello-world", "--use-docker"],
          childLayer: child.layer,
        });

        // CLI-1963: `--use-docker` now runs the native Docker-unbundle path
        // instead of delegating to the Go proxy.
        yield* functionsDownload({
          ...BASE_FLAGS,
          useDocker: true,
        }).pipe(Effect.provide(layer));

        expect(proxy.calls).toEqual([]);
        expect(proxy.captureCalls).toEqual([]);
        const runCommand = child.spawned.find(
          (spawned) => spawned.command === "docker" && spawned.args[0] === "run",
        );
        expect(runCommand?.args).toContain("unbundle");
        expect(out.stderrText).toContain("Downloading function: hello-world\n");
        // No `--debug` — the temp eszip file is removed after the run.
        expect(existsSync(join(tempDir, "supabase", ".temp", "output_hello-world.eszip"))).toBe(
          false,
        );
      }).pipe(
        Effect.ensuring(Effect.tryPromise(() => rm(tempDir, { recursive: true, force: true }))),
      );
    },
  );

  it.live("runs the native Docker path and emits a JSON envelope in machine mode", () => {
    const tempDir = makeTempDir();
    const child = mockChildProcessSpawner({ exitCode: 0 });

    return Effect.gen(function* () {
      yield* Effect.tryPromise(() => writeCliConfig(tempDir));
      const { out, layer, proxy } = setup(tempDir, {
        format: "json",
        bodyBySlug: {
          "hello-world": { body: "fake-eszip-bytes", contentType: "application/octet-stream" },
        },
        rawArgs: ["functions", "download", "hello-world", "--use-docker"],
        childLayer: child.layer,
      });

      // CLI-1963: `--use-docker` now runs the native Docker-unbundle path;
      // this asserts the JSON envelope this command emits itself still
      // shows up correctly once the native path is exercised in machine mode.
      yield* functionsDownload({
        ...BASE_FLAGS,
        useDocker: true,
      }).pipe(Effect.provide(layer));

      expect(proxy.calls).toEqual([]);
      expect(proxy.captureCalls).toEqual([]);
      expect(
        child.spawned.some((spawned) => spawned.command === "docker" && spawned.args[0] === "run"),
      ).toBe(true);
      expect(out.messages).toContainEqual(
        expect.objectContaining({
          type: "success",
          message: "Downloaded Edge Function source.",
          data: {
            function_slugs: ["hello-world"],
            project_ref: PROJECT_REF,
          },
        }),
      );
    }).pipe(
      Effect.ensuring(Effect.tryPromise(() => rm(tempDir, { recursive: true, force: true }))),
    );
  });

  it.live("lists remote functions and downloads each natively via Docker in machine mode", () => {
    const tempDir = makeTempDir();
    const child = mockChildProcessSpawner({ exitCode: 0 });

    return Effect.gen(function* () {
      yield* Effect.tryPromise(() => writeCliConfig(tempDir));
      const { out, layer, proxy } = setup(tempDir, {
        format: "json",
        list: [makeFunction({ slug: "hello-world" }), makeFunction({ slug: "goodbye-world" })],
        bodyBySlug: {
          "hello-world": { body: "fake-eszip-bytes", contentType: "application/octet-stream" },
          "goodbye-world": { body: "fake-eszip-bytes", contentType: "application/octet-stream" },
        },
        rawArgs: ["functions", "download", "--use-docker"],
        childLayer: child.layer,
      });

      yield* functionsDownload({
        ...BASE_FLAGS,
        functionName: Option.none(),
        useDocker: true,
      }).pipe(Effect.provide(layer));

      expect(proxy.calls).toEqual([]);
      expect(proxy.captureCalls).toEqual([]);
      expect(
        child.spawned.filter(
          (spawned) => spawned.command === "docker" && spawned.args[0] === "run",
        ),
      ).toHaveLength(2);
      expect(out.messages).toContainEqual(
        expect.objectContaining({
          type: "success",
          message: "Downloaded Edge Function source.",
          data: {
            function_slugs: ["hello-world", "goodbye-world"],
            project_ref: PROJECT_REF,
          },
        }),
      );
    }).pipe(
      Effect.ensuring(Effect.tryPromise(() => rm(tempDir, { recursive: true, force: true }))),
    );
  });

  it.live(
    "defaults --use-docker to true so a bare invocation still runs the native Docker path",
    () => {
      const tempDir = makeTempDir();
      const child = mockChildProcessSpawner({ exitCode: 0 });

      return Effect.gen(function* () {
        yield* Effect.tryPromise(() => writeCliConfig(tempDir));
        const { layer, proxy } = setup(tempDir, {
          bodyBySlug: {
            "hello-world": { body: "fake-eszip-bytes", contentType: "application/octet-stream" },
          },
          // No `--use-docker` at all — mirrors a bare `supabase functions
          // download hello-world` invocation relying on the flag's default.
          rawArgs: ["functions", "download", "hello-world"],
          childLayer: child.layer,
        });

        // `useDocker: true` is what `download.command.ts`'s
        // `Flag.withDefault(true)` resolves to when the flag is omitted
        // (CLI-1963 parity fix — `next` was previously missing this default,
        // unlike the legacy shell's equivalent command).
        yield* functionsDownload({
          ...BASE_FLAGS,
          useDocker: true,
        }).pipe(Effect.provide(layer));

        expect(proxy.calls).toEqual([]);
        expect(
          child.spawned.some(
            (spawned) => spawned.command === "docker" && spawned.args[0] === "run",
          ),
        ).toBe(true);
      }).pipe(
        Effect.ensuring(Effect.tryPromise(() => rm(tempDir, { recursive: true, force: true }))),
      );
    },
  );

  it.live(
    "falls back to the native server-side path with a warning when Docker is not running",
    () => {
      const tempDir = makeTempDir();
      const child = mockChildProcessSpawner({ exitCode: 1 });
      const multipart = multipartBody([
        {
          headers: {
            "Content-Disposition": 'form-data; name="metadata"',
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ deno2_entrypoint_path: "source/index.ts" }),
        },
        {
          headers: {
            "Content-Disposition": 'form-data; name="file"; filename="source/index.ts"',
          },
          body: "console.log('fallback')",
        },
      ]);

      return Effect.gen(function* () {
        yield* Effect.tryPromise(() => writeCliConfig(tempDir));
        const { out, layer } = setup(tempDir, {
          bodyBySlug: { "hello-world": multipart },
          rawArgs: ["functions", "download", "hello-world", "--use-docker"],
          childLayer: child.layer,
        });

        yield* functionsDownload({
          ...BASE_FLAGS,
          useDocker: true,
        }).pipe(Effect.provide(layer));

        expect(child.spawned).toEqual([{ command: "docker", args: ["info"] }]);
        expect(out.stderrText).toContain("WARNING: Docker is not running\n");
        expect(
          yield* Effect.tryPromise(() =>
            readFile(join(tempDir, "supabase", "functions", "hello-world", "index.ts"), "utf8"),
          ),
        ).toBe("console.log('fallback')");
      }).pipe(
        Effect.ensuring(Effect.tryPromise(() => rm(tempDir, { recursive: true, force: true }))),
      );
    },
  );

  it.live(
    "writes the eszip response body to disk exactly as received, regardless of Content-Encoding",
    () => {
      const tempDir = makeTempDir();
      const child = mockChildProcessSpawner({ exitCode: 0 });
      // Arbitrary binary bytes, not valid brotli — this mocked `Response` (a
      // hand-built `new Response(body, {...})`, unlike a real `fetch()`)
      // never applies transport-level content-decoding, so a
      // `Content-Encoding: br` header here must have zero effect on what
      // `downloadEszipBody` does with it. If production code ever tried to
      // brotli-decompress this body again, decompression itself would throw
      // on these bytes, failing this test.
      const rawEszipBytes = new Uint8Array([0, 1, 2, 253, 254, 255, 10, 13, 0, 128, 200]);

      return Effect.gen(function* () {
        yield* Effect.tryPromise(() => writeCliConfig(tempDir));
        const { layer } = setup(tempDir, {
          bodyBySlug: {
            "hello-world": {
              body: new Blob([rawEszipBytes]),
              contentType: "application/octet-stream",
              headers: { "content-encoding": "br" },
            },
          },
          // `--debug` keeps the temp eszip file on disk after a successful
          // run so this test can inspect the exact bytes that were written.
          rawArgs: ["functions", "download", "hello-world", "--use-docker", "--debug"],
          childLayer: child.layer,
        });

        yield* functionsDownload({
          ...BASE_FLAGS,
          useDocker: true,
        }).pipe(Effect.provide(layer));

        const written = yield* Effect.tryPromise(() =>
          readFile(join(tempDir, "supabase", ".temp", "output_hello-world.eszip")),
        );
        expect(new Uint8Array(written)).toEqual(rawEszipBytes);
      }).pipe(
        Effect.ensuring(Effect.tryPromise(() => rm(tempDir, { recursive: true, force: true }))),
      );
    },
  );

  it.live(
    "reports no functions found without delegating when the project is empty in machine mode",
    () => {
      const tempDir = makeTempDir();

      return Effect.gen(function* () {
        yield* Effect.tryPromise(() => writeCliConfig(tempDir));
        const { out, layer, proxy } = setup(tempDir, {
          format: "json",
          list: [],
          rawArgs: ["functions", "download", "--use-docker"],
        });

        // An empty project has nothing to delegate — this must match the
        // native path's "No functions found." short-circuit instead of
        // still invoking the Go/Docker child and reporting a misleading
        // "Downloaded Edge Function source." success with an empty list.
        yield* functionsDownload({
          ...BASE_FLAGS,
          functionName: Option.none(),
          useDocker: true,
        }).pipe(Effect.provide(layer));

        expect(proxy.calls).toEqual([]);
        expect(proxy.captureCalls).toEqual([]);
        expect(out.messages).toContainEqual(
          expect.objectContaining({
            type: "success",
            message: "No functions found.",
            data: { function_slugs: [], project_ref: PROJECT_REF },
          }),
        );
      }).pipe(
        Effect.ensuring(Effect.tryPromise(() => rm(tempDir, { recursive: true, force: true }))),
      );
    },
  );

  it.live("fails before delegating when the pre-flight function list fails in machine mode", () => {
    const tempDir = makeTempDir();

    return Effect.gen(function* () {
      yield* Effect.tryPromise(() => writeCliConfig(tempDir));
      const { layer, proxy } = setup(tempDir, {
        format: "json",
        listStatus: 503,
        listBody: { message: "unavailable" },
        rawArgs: ["functions", "download", "--use-docker"],
      });

      // The pre-flight list failure must be reported before any download
      // side effect — the delegated proxy must never be invoked (CLI-1862
      // review: a listing failure after a successful delegated download
      // must not mask that success).
      const error = yield* functionsDownload({
        ...BASE_FLAGS,
        functionName: Option.none(),
        useDocker: true,
      }).pipe(Effect.provide(layer), Effect.flip);

      expect(error).toBeInstanceOf(Error);
      expect(proxy.calls).toEqual([]);
      expect(proxy.captureCalls).toEqual([]);
    }).pipe(
      Effect.ensuring(Effect.tryPromise(() => rm(tempDir, { recursive: true, force: true }))),
    );
  });

  it.live("rejects mutually exclusive compatibility flags", () => {
    const tempDir = makeTempDir();

    return Effect.gen(function* () {
      const { api, layer, proxy } = setup(tempDir, {
        rawArgs: ["functions", "download", "hello-world", "--use-api", "--legacy-bundle"],
      });

      const error = yield* functionsDownload({
        ...BASE_FLAGS,
        useApi: true,
        legacyBundle: true,
      }).pipe(Effect.provide(layer), Effect.flip);

      expect(error).toBeInstanceOf(ConflictingFunctionDownloadFlagsError);
      if (!(error instanceof ConflictingFunctionDownloadFlagsError)) {
        throw new Error(`unexpected error: ${String(error)}`);
      }
      // Byte-matches cobra's validateExclusiveFlagGroups (flag_groups.go:204):
      // full group in registration order, changed subset sorted alphabetically.
      expect(error.message).toBe(
        "if any flags in the group [use-api use-docker legacy-bundle] are set none of the others can be; [legacy-bundle use-api] were all set",
      );
      expect(api.requests).toHaveLength(0);
      expect(proxy.calls).toHaveLength(0);
    }).pipe(
      Effect.ensuring(Effect.tryPromise(() => rm(tempDir, { recursive: true, force: true }))),
    );
  });

  it.live("still rejects the bundler mutex when --use-docker=false is explicit", () => {
    const tempDir = makeTempDir();

    return Effect.gen(function* () {
      const { api, layer, proxy } = setup(tempDir, {
        rawArgs: ["functions", "download", "--use-api", "--use-docker=false"],
      });

      const error = yield* functionsDownload({
        ...BASE_FLAGS,
        useApi: true,
        useDocker: false,
      }).pipe(Effect.provide(layer), Effect.flip);

      expect(error).toBeInstanceOf(ConflictingFunctionDownloadFlagsError);
      if (!(error instanceof ConflictingFunctionDownloadFlagsError)) {
        throw new Error(`unexpected error: ${String(error)}`);
      }
      // cobra tracks pflag.Changed, not the resolved boolean value — an
      // explicit --use-docker=false still counts as "set" for the mutex.
      // Regression case: download previously branched on flag truthiness,
      // so --use-docker=false (falsy) was silently excluded from the check.
      expect(error.message).toBe(
        "if any flags in the group [use-api use-docker legacy-bundle] are set none of the others can be; [use-api use-docker] were all set",
      );
      expect(api.requests).toHaveLength(0);
      expect(proxy.calls).toHaveLength(0);
    }).pipe(
      Effect.ensuring(Effect.tryPromise(() => rm(tempDir, { recursive: true, force: true }))),
    );
  });

  it.live("rejects invalid slugs before calling the API", () => {
    const tempDir = makeTempDir();

    return Effect.gen(function* () {
      yield* Effect.tryPromise(() => writeCliConfig(tempDir));
      const { api, layer } = setup(tempDir);

      const error = yield* functionsDownload({
        ...BASE_FLAGS,
        functionName: Option.some("hello.world"),
      }).pipe(Effect.provide(layer), Effect.flip);

      expect(error).toBeInstanceOf(InvalidFunctionSlugError);
      expect(api.requests).toHaveLength(0);
    }).pipe(
      Effect.ensuring(Effect.tryPromise(() => rm(tempDir, { recursive: true, force: true }))),
    );
  });

  it.live("fails when neither a linked project nor --project-ref is available", () => {
    const tempDir = makeTempDir();

    return Effect.gen(function* () {
      yield* Effect.tryPromise(() => writeCliConfig(tempDir));
      const { layer } = setup(tempDir, { linked: false });

      const error = yield* functionsDownload(BASE_FLAGS).pipe(Effect.provide(layer), Effect.flip);

      expect(error).toBeInstanceOf(ProjectNotLinkedError);
    }).pipe(
      Effect.ensuring(Effect.tryPromise(() => rm(tempDir, { recursive: true, force: true }))),
    );
  });

  it.live("prints the Go-style empty-state line when no functions exist", () => {
    const tempDir = makeTempDir();

    return Effect.gen(function* () {
      yield* Effect.tryPromise(() => writeCliConfig(tempDir));
      const { out, layer } = setup(tempDir, {
        list: [],
      });

      yield* functionsDownload({
        ...BASE_FLAGS,
        functionName: Option.none(),
      }).pipe(Effect.provide(layer));

      expect(out.stderrText).toBe("No functions found in project  abcdefghijklmnopqrst\n");
    }).pipe(
      Effect.ensuring(Effect.tryPromise(() => rm(tempDir, { recursive: true, force: true }))),
    );
  });

  it.live("fails when the response is not multipart", () => {
    const tempDir = makeTempDir();

    return Effect.gen(function* () {
      yield* Effect.tryPromise(() => writeCliConfig(tempDir));
      const { layer } = setup(tempDir, {
        bodyBySlug: {
          "hello-world": {
            body: `{"error":"no multipart"}`,
            contentType: "application/json",
          },
        },
      });

      const error = yield* functionsDownload(BASE_FLAGS).pipe(Effect.provide(layer), Effect.flip);

      expect(error).toBeInstanceOf(InvalidFunctionDownloadResponseError);
    }).pipe(
      Effect.ensuring(Effect.tryPromise(() => rm(tempDir, { recursive: true, force: true }))),
    );
  });

  it.live("fails when the multipart boundary is absent from the response body", () => {
    const tempDir = makeTempDir();

    return Effect.gen(function* () {
      yield* Effect.tryPromise(() => writeCliConfig(tempDir));
      const { layer } = setup(tempDir, {
        bodyBySlug: {
          "hello-world": {
            body: "not a multipart body",
            contentType: "multipart/form-data; boundary=missing",
          },
        },
      });

      const error = yield* functionsDownload(BASE_FLAGS).pipe(Effect.provide(layer), Effect.flip);

      expect(error).toBeInstanceOf(InvalidFunctionDownloadResponseError);
      expect(error.message).toBe(
        "failed to read form: multipart response is missing its opening boundary",
      );
    }).pipe(
      Effect.ensuring(Effect.tryPromise(() => rm(tempDir, { recursive: true, force: true }))),
    );
  });

  it.live("fails when a multipart file has malformed content disposition", () => {
    const tempDir = makeTempDir();
    const multipart = multipartBody([
      {
        headers: {
          "Content-Disposition": 'form-data; name="metadata"',
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ deno2_entrypoint_path: "source/index.ts" }),
      },
      {
        headers: {
          "Content-Disposition": 'form-data; name="file"; filename="',
        },
        body: "console.log('hello')",
      },
    ]);

    return Effect.gen(function* () {
      yield* Effect.tryPromise(() => writeCliConfig(tempDir));
      const { layer } = setup(tempDir, {
        bodyBySlug: {
          "hello-world": multipart,
        },
      });

      const error = yield* functionsDownload(BASE_FLAGS).pipe(Effect.provide(layer), Effect.flip);

      expect(error).toBeInstanceOf(InvalidFunctionDownloadResponseError);
      expect(error.message).toBe("failed to parse content disposition: malformed filename");
    }).pipe(
      Effect.ensuring(Effect.tryPromise(() => rm(tempDir, { recursive: true, force: true }))),
    );
  });

  it.live("writes structured success data in JSON mode for native downloads", () => {
    const tempDir = makeTempDir();
    const multipart = multipartBody([
      {
        headers: {
          "Content-Disposition": 'form-data; name="metadata"',
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ deno2_entrypoint_path: "source/index.ts" }),
      },
      {
        headers: {
          "Content-Disposition": 'form-data; name="file"; filename="source/index.ts"',
        },
        body: "console.log('hello')",
      },
    ]);

    return Effect.gen(function* () {
      yield* Effect.tryPromise(() => writeCliConfig(tempDir));
      const { out, layer } = setup(tempDir, {
        format: "json",
        bodyBySlug: {
          "hello-world": multipart,
        },
      });

      yield* functionsDownload(BASE_FLAGS).pipe(Effect.provide(layer));

      expect(out.messages).toContainEqual(
        expect.objectContaining({
          type: "success",
          message: "Downloaded Edge Function source.",
          data: {
            function_slugs: ["hello-world"],
            project_ref: PROJECT_REF,
          },
        }),
      );
    }).pipe(
      Effect.ensuring(Effect.tryPromise(() => rm(tempDir, { recursive: true, force: true }))),
    );
  });

  it.live("maps list transport errors with Go-style wording", () => {
    const tempDir = makeTempDir();

    return Effect.gen(function* () {
      yield* Effect.tryPromise(() => writeCliConfig(tempDir));
      const { layer } = setup(tempDir, {
        listError: new Error("network error"),
      });

      const error = yield* functionsDownload({
        ...BASE_FLAGS,
        functionName: Option.none(),
      }).pipe(Effect.provide(layer), Effect.flip);

      expect(error).toBeInstanceOf(Error);
      expect(error.message).toBe("failed to list functions: network error");
    }).pipe(
      Effect.ensuring(Effect.tryPromise(() => rm(tempDir, { recursive: true, force: true }))),
    );
  });

  it.live("maps unexpected list statuses with Go-style wording", () => {
    const tempDir = makeTempDir();

    return Effect.gen(function* () {
      yield* Effect.tryPromise(() => writeCliConfig(tempDir));
      const { layer } = setup(tempDir, {
        listStatus: 503,
        listBody: { message: "unavailable" },
      });

      const error = yield* functionsDownload({
        ...BASE_FLAGS,
        functionName: Option.none(),
      }).pipe(Effect.provide(layer), Effect.flip);

      expect(error).toBeInstanceOf(Error);
      expect(error.message).toBe('unexpected list functions status 503: {"message":"unavailable"}');
    }).pipe(
      Effect.ensuring(Effect.tryPromise(() => rm(tempDir, { recursive: true, force: true }))),
    );
  });

  it.live("maps body transport errors with Go-style wording", () => {
    const tempDir = makeTempDir();

    return Effect.gen(function* () {
      yield* Effect.tryPromise(() => writeCliConfig(tempDir));
      const { layer } = setup(tempDir, {
        bodyErrorBySlug: {
          "hello-world": new Error("network error"),
        },
      });

      const error = yield* functionsDownload(BASE_FLAGS).pipe(Effect.provide(layer), Effect.flip);

      expect(error).toBeInstanceOf(Error);
      expect(error.message).toBe("failed to download function: network error");
    }).pipe(
      Effect.ensuring(Effect.tryPromise(() => rm(tempDir, { recursive: true, force: true }))),
    );
  });

  it.live("maps unexpected body statuses with Go-style wording", () => {
    const tempDir = makeTempDir();

    return Effect.gen(function* () {
      yield* Effect.tryPromise(() => writeCliConfig(tempDir));
      const { layer } = setup(tempDir, {
        bodyBySlug: {
          "hello-world": {
            status: 503,
            body: "unavailable",
            contentType: "text/plain",
          },
        },
      });

      const error = yield* functionsDownload(BASE_FLAGS).pipe(Effect.provide(layer), Effect.flip);

      expect(error).toBeInstanceOf(Error);
      expect(error.message).toBe("Error status 503: unavailable");
    }).pipe(
      Effect.ensuring(Effect.tryPromise(() => rm(tempDir, { recursive: true, force: true }))),
    );
  });

  it.live("maps eszip body transport errors with Go-style wording (Docker path)", () => {
    const tempDir = makeTempDir();
    const child = mockChildProcessSpawner({ exitCode: 0 });

    return Effect.gen(function* () {
      yield* Effect.tryPromise(() => writeCliConfig(tempDir));
      const { layer } = setup(tempDir, {
        bodyErrorBySlug: {
          "hello-world": new Error("network error"),
        },
        rawArgs: ["functions", "download", "hello-world", "--use-docker"],
        childLayer: child.layer,
      });

      // `downloadEszipBody` (the Docker path's own GET) uses a distinct
      // error prefix ("failed to get function body") from the server-side
      // `downloadBody`'s ("failed to download function") — Go parity.
      const error = yield* functionsDownload({
        ...BASE_FLAGS,
        useDocker: true,
      }).pipe(Effect.provide(layer), Effect.flip);

      expect(error).toBeInstanceOf(Error);
      expect(error.message).toBe("failed to get function body: network error");
    }).pipe(
      Effect.ensuring(Effect.tryPromise(() => rm(tempDir, { recursive: true, force: true }))),
    );
  });

  it.live("maps unexpected eszip body statuses with Go-style wording (Docker path)", () => {
    const tempDir = makeTempDir();
    const child = mockChildProcessSpawner({ exitCode: 0 });

    return Effect.gen(function* () {
      yield* Effect.tryPromise(() => writeCliConfig(tempDir));
      const { layer } = setup(tempDir, {
        bodyBySlug: {
          "hello-world": {
            status: 503,
            body: "unavailable",
            contentType: "text/plain",
          },
        },
        rawArgs: ["functions", "download", "hello-world", "--use-docker"],
        childLayer: child.layer,
      });

      const error = yield* functionsDownload({
        ...BASE_FLAGS,
        useDocker: true,
      }).pipe(Effect.provide(layer), Effect.flip);

      expect(error).toBeInstanceOf(Error);
      expect(error.message).toBe("Error status 503: unavailable");
    }).pipe(
      Effect.ensuring(Effect.tryPromise(() => rm(tempDir, { recursive: true, force: true }))),
    );
  });

  it.live("maps metadata fallback transport errors with Go-style wording", () => {
    const tempDir = makeTempDir();
    const multipart = multipartBody([
      {
        headers: {
          "Content-Disposition": 'form-data; name="metadata"',
          "Content-Type": "application/json",
        },
        body: JSON.stringify({}),
      },
      {
        headers: {
          "Content-Disposition": 'form-data; name="file"; filename="/tmp/source/index.ts"',
        },
        body: "console.log('hello')",
      },
    ]);

    return Effect.gen(function* () {
      yield* Effect.tryPromise(() => writeCliConfig(tempDir));
      const { layer } = setup(tempDir, {
        bodyBySlug: {
          "hello-world": multipart,
        },
        functionStatusBySlug: {
          "hello-world": 503,
        },
        functionBodyBySlug: {
          "hello-world": { message: "downstream unavailable" },
        },
      });

      const error = yield* functionsDownload(BASE_FLAGS).pipe(Effect.provide(layer), Effect.flip);

      expect(error).toBeInstanceOf(Error);
      expect(error.message).toBe(
        'Failed to download Function hello-world on the Supabase project: {"message":"downstream unavailable"}',
      );
    }).pipe(
      Effect.ensuring(Effect.tryPromise(() => rm(tempDir, { recursive: true, force: true }))),
    );
  });

  it.live("honors Supabase-Path headers for files shared across functions", () => {
    const tempDir = makeTempDir();
    const multipart = multipartBody([
      {
        headers: {
          "Content-Disposition": 'form-data; name="metadata"',
          "Content-Type": "application/json",
        },
        body: JSON.stringify({}),
      },
      {
        headers: {
          "Content-Disposition": 'form-data; name="file"; filename="source/index.ts"',
        },
        body: "console.log('hello')",
      },
      {
        headers: {
          "Content-Disposition": 'form-data; name="file"; filename="source/secret.env"',
          "Supabase-Path": "../secret.env",
        },
        body: "SECRET=1",
      },
    ]);

    return Effect.gen(function* () {
      yield* Effect.tryPromise(() => writeCliConfig(tempDir));
      const { layer } = setup(tempDir, {
        bodyBySlug: {
          "hello-world": multipart,
        },
        functionBySlug: {
          "hello-world": makeFunction({
            slug: "hello-world",
            entrypoint_path: "file:///source/index.ts",
          }),
        },
      });

      yield* functionsDownload(BASE_FLAGS).pipe(Effect.provide(layer));

      expect(
        yield* Effect.tryPromise(() =>
          readFile(join(tempDir, "supabase", "functions", "secret.env"), "utf8"),
        ),
      ).toBe("SECRET=1");
    }).pipe(
      Effect.ensuring(Effect.tryPromise(() => rm(tempDir, { recursive: true, force: true }))),
    );
  });

  it.live("rejects Supabase-Path headers that escape the functions directory", () => {
    const tempDir = makeTempDir();
    const multipart = multipartBody([
      {
        headers: {
          "Content-Disposition": 'form-data; name="metadata"',
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ deno2_entrypoint_path: "source/index.ts" }),
      },
      {
        headers: {
          "Content-Disposition": 'form-data; name="file"; filename="source/secret.env"',
          "Supabase-Path": "../../../../../../outside.env",
        },
        body: "SECRET=1",
      },
    ]);

    return Effect.gen(function* () {
      yield* Effect.tryPromise(() => writeCliConfig(tempDir));
      const { layer } = setup(tempDir, {
        bodyBySlug: {
          "hello-world": multipart,
        },
      });

      const error = yield* functionsDownload(BASE_FLAGS).pipe(Effect.provide(layer), Effect.flip);

      expect(error).toBeInstanceOf(UnsafeFunctionDownloadPathError);
    }).pipe(
      Effect.ensuring(Effect.tryPromise(() => rm(tempDir, { recursive: true, force: true }))),
    );
  });

  it.live("rejects a functions directory symlinked outside the project", () => {
    const tempDir = makeTempDir();
    const outsideDir = makeTempDir();
    const multipart = multipartBody([
      {
        headers: {
          "Content-Disposition": 'form-data; name="metadata"',
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ deno2_entrypoint_path: "source/index.ts" }),
      },
      {
        headers: {
          "Content-Disposition": 'form-data; name="file"; filename="source/index.ts"',
        },
        body: "console.log('hello')",
      },
    ]);

    return Effect.gen(function* () {
      yield* Effect.tryPromise(() => writeCliConfig(tempDir));
      yield* Effect.tryPromise(() =>
        symlink(outsideDir, join(tempDir, "supabase", "functions"), "junction"),
      );
      const { layer } = setup(tempDir, {
        bodyBySlug: {
          "hello-world": multipart,
        },
      });

      const error = yield* functionsDownload(BASE_FLAGS).pipe(Effect.provide(layer), Effect.flip);

      expect(error).toBeInstanceOf(UnsafeFunctionDownloadPathError);
    }).pipe(
      Effect.ensuring(
        Effect.all([
          Effect.tryPromise(() => rm(tempDir, { recursive: true, force: true })),
          Effect.tryPromise(() => rm(outsideDir, { recursive: true, force: true })),
        ]).pipe(Effect.orDie),
      ),
    );
  });

  it.live("rejects a symlinked supabase directory before creating the functions directory", () => {
    const tempDir = makeTempDir();
    const outsideDir = makeTempDir();
    const multipart = multipartBody([
      {
        headers: {
          "Content-Disposition": 'form-data; name="metadata"',
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ deno2_entrypoint_path: "source/index.ts" }),
      },
      {
        headers: {
          "Content-Disposition": 'form-data; name="file"; filename="source/index.ts"',
        },
        body: "console.log('hello')",
      },
    ]);

    return Effect.gen(function* () {
      yield* Effect.tryPromise(() => symlink(outsideDir, join(tempDir, "supabase"), "junction"));
      const { layer } = setup(tempDir, {
        bodyBySlug: {
          "hello-world": multipart,
        },
      });

      const error = yield* functionsDownload(BASE_FLAGS).pipe(Effect.provide(layer), Effect.flip);

      expect(error).toBeInstanceOf(UnsafeFunctionDownloadPathError);
      expect(existsSync(join(outsideDir, "functions"))).toBe(false);
    }).pipe(
      Effect.ensuring(
        Effect.all([
          Effect.tryPromise(() => rm(tempDir, { recursive: true, force: true })),
          Effect.tryPromise(() => rm(outsideDir, { recursive: true, force: true })),
        ]).pipe(Effect.orDie),
      ),
    );
  });

  it.live("rejects symlinked parent directories before creating descendants", () => {
    const tempDir = makeTempDir();
    const outsideDir = makeTempDir();
    const functionDir = join(tempDir, "supabase", "functions", "hello-world");
    const multipart = multipartBody([
      {
        headers: {
          "Content-Disposition": 'form-data; name="metadata"',
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ deno2_entrypoint_path: "source/index.ts" }),
      },
      {
        headers: {
          "Content-Disposition":
            'form-data; name="file"; filename="source/lib/new-directory/file.ts"',
        },
        body: "console.log('outside')",
      },
    ]);

    return Effect.gen(function* () {
      yield* Effect.tryPromise(() => mkdir(functionDir, { recursive: true }));
      yield* Effect.tryPromise(() => symlink(outsideDir, join(functionDir, "lib"), "junction"));
      const { layer } = setup(tempDir, {
        bodyBySlug: {
          "hello-world": multipart,
        },
      });

      const error = yield* functionsDownload(BASE_FLAGS).pipe(Effect.provide(layer), Effect.flip);

      expect(error).toBeInstanceOf(UnsafeFunctionDownloadPathError);
      expect(existsSync(join(outsideDir, "new-directory"))).toBe(false);
    }).pipe(
      Effect.ensuring(
        Effect.all([
          Effect.tryPromise(() => rm(tempDir, { recursive: true, force: true })),
          Effect.tryPromise(() => rm(outsideDir, { recursive: true, force: true })),
        ]).pipe(Effect.orDie),
      ),
    );
  });

  it.live("emits a JSON failure payload instead of throwing in JSON mode", () => {
    const tempDir = makeTempDir();

    return Effect.gen(function* () {
      yield* Effect.tryPromise(() => writeCliConfig(tempDir));
      const { out, layer } = setup(tempDir, {
        format: "json",
        bodyBySlug: {
          "hello-world": {
            body: `{"error":"no multipart"}`,
            contentType: "application/json",
          },
        },
      });

      yield* functionsDownload(BASE_FLAGS).pipe(withJsonErrorHandling, Effect.provide(layer));

      expect(out.messages).toContainEqual(expect.objectContaining({ type: "fail" }));
    }).pipe(
      Effect.ensuring(Effect.tryPromise(() => rm(tempDir, { recursive: true, force: true }))),
    );
  });

  describe("Go's Config.Validate/env-override parity is legacy-only (CLI-1963)", () => {
    it.live(
      "does not fail on an explicit empty project_id, unlike the legacy shell's Config.Validate",
      () => {
        const tempDir = makeTempDir();
        const child = mockChildProcessSpawner({ exitCode: 0 });

        return Effect.gen(function* () {
          yield* Effect.tryPromise(() => mkdir(join(tempDir, "supabase"), { recursive: true }));
          yield* Effect.tryPromise(() =>
            writeFile(join(tempDir, "supabase", "config.toml"), 'project_id = ""\n'),
          );
          const { out, layer, proxy } = setup(tempDir, {
            bodyBySlug: {
              "hello-world": { body: "fake-eszip-bytes", contentType: "application/octet-stream" },
            },
            rawArgs: ["functions", "download", "hello-world", "--use-docker"],
            childLayer: child.layer,
          });

          yield* functionsDownload({ ...BASE_FLAGS, useDocker: true }).pipe(Effect.provide(layer));

          expect(proxy.calls).toEqual([]);
          expect(
            child.spawned.some(
              (spawned) => spawned.command === "docker" && spawned.args[0] === "run",
            ),
          ).toBe(true);
          expect(out.stderrText).toContain("Downloading function: hello-world\n");
        }).pipe(
          Effect.ensuring(Effect.tryPromise(() => rm(tempDir, { recursive: true, force: true }))),
        );
      },
    );

    it.live(
      "does not fail on an unrelated Config.Validate branch (unsupported Postgres major version)",
      () => {
        const tempDir = makeTempDir();
        const child = mockChildProcessSpawner({ exitCode: 0 });

        return Effect.gen(function* () {
          yield* Effect.tryPromise(() => mkdir(join(tempDir, "supabase"), { recursive: true }));
          yield* Effect.tryPromise(() =>
            writeFile(
              join(tempDir, "supabase", "config.toml"),
              ['project_id = "test-project"', "", "[db]", "major_version = 12", ""].join("\n"),
            ),
          );
          const { out, layer, proxy } = setup(tempDir, {
            bodyBySlug: {
              "hello-world": { body: "fake-eszip-bytes", contentType: "application/octet-stream" },
            },
            rawArgs: ["functions", "download", "hello-world", "--use-docker"],
            childLayer: child.layer,
          });

          yield* functionsDownload({ ...BASE_FLAGS, useDocker: true }).pipe(Effect.provide(layer));

          expect(proxy.calls).toEqual([]);
          expect(
            child.spawned.some(
              (spawned) => spawned.command === "docker" && spawned.args[0] === "run",
            ),
          ).toBe(true);
          expect(out.stderrText).toContain("Downloading function: hello-world\n");
        }).pipe(
          Effect.ensuring(Effect.tryPromise(() => rm(tempDir, { recursive: true, force: true }))),
        );
      },
    );

    it.live(
      "ignores SUPABASE_EDGE_RUNTIME_DENO_VERSION and resolves the default edge-runtime image tag",
      () => {
        const tempDir = makeTempDir();
        const child = mockChildProcessSpawner({ exitCode: 0 });
        const previous = process.env["SUPABASE_EDGE_RUNTIME_DENO_VERSION"];
        process.env["SUPABASE_EDGE_RUNTIME_DENO_VERSION"] = "1";

        return Effect.gen(function* () {
          yield* Effect.tryPromise(() => writeCliConfig(tempDir));
          const { layer, proxy } = setup(tempDir, {
            bodyBySlug: {
              "hello-world": { body: "fake-eszip-bytes", contentType: "application/octet-stream" },
            },
            rawArgs: ["functions", "download", "hello-world", "--use-docker"],
            childLayer: child.layer,
          });

          yield* functionsDownload({ ...BASE_FLAGS, useDocker: true }).pipe(Effect.provide(layer));

          expect(proxy.calls).toEqual([]);
          const runCommand = child.spawned.find(
            (spawned) => spawned.command === "docker" && spawned.args[0] === "run",
          );
          expect(runCommand?.args).toContain(
            `public.ecr.aws/${dockerfileServiceImage("edgeruntime")}`,
          );
        }).pipe(
          Effect.ensuring(Effect.tryPromise(() => rm(tempDir, { recursive: true, force: true }))),
          Effect.ensuring(
            Effect.sync(() => {
              if (previous === undefined) {
                delete process.env["SUPABASE_EDGE_RUNTIME_DENO_VERSION"];
              } else {
                process.env["SUPABASE_EDGE_RUNTIME_DENO_VERSION"] = previous;
              }
            }),
          ),
        );
      },
    );
  });
});
