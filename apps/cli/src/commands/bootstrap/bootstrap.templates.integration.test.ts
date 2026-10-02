import { BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import { Effect, FileSystem, Layer, Option, Path, Redacted } from "effect";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";

import { mockCommandSettings } from "../../../tests/helpers/command-mocks.ts";
import { mockOutput } from "../../../tests/helpers/mocks.ts";
import { BootstrapTemplateDownloadError, BootstrapTemplateListError } from "./bootstrap.errors.ts";
import { TemplateService, templateServiceLayer } from "./bootstrap.templates.ts";

const SAMPLES = {
  samples: [
    {
      name: "nextjs",
      description: "Next.js starter.",
      url: "https://example.test/t",
      start: "npm run dev",
    },
    { description: "no name, filtered out" },
  ],
};

function setup(opts: { githubToken?: string; content?: string } = {}) {
  const requests: Array<{ url: string; headers: Record<string, string> }> = [];
  const content = Buffer.from(opts.content ?? JSON.stringify(SAMPLES), "utf8").toString("base64");
  const httpLayer = Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request: HttpClientRequest.HttpClientRequest) => {
      requests.push({
        url: request.url,
        headers: Object.fromEntries(
          Object.entries(request.headers).map(([k, v]) => [k.toLowerCase(), String(v)]),
        ),
      });
      return Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          new Response(JSON.stringify({ content, encoding: "base64" }), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
        ),
      );
    }),
  );
  const settings = mockCommandSettings({
    workdir: "/",
    githubToken:
      opts.githubToken === undefined ? Option.none() : Option.some(Redacted.make(opts.githubToken)),
  });
  const layer = templateServiceLayer.pipe(
    Layer.provide(httpLayer),
    Layer.provide(settings),
    Layer.provide(mockOutput().layer),
    Layer.provide(BunServices.layer),
  );
  return { layer, requests };
}

interface DownloadEntry {
  readonly type: string;
  readonly path: string;
  readonly download_url?: string | null;
}

function setupDownload(listings: Readonly<Record<string, ReadonlyArray<DownloadEntry>>>) {
  const httpLayer = Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request: HttpClientRequest.HttpClientRequest) => {
      const url = new URL(request.url);
      if (url.hostname === "files.test") {
        return Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            new Response(`content of ${url.pathname}`, { status: 200 }),
          ),
        );
      }
      const contentPath = decodeURIComponent(
        url.pathname.replace(/^\/repos\/[^/]+\/[^/]+\/contents\/?/, ""),
      );
      const listing = listings[contentPath] ?? [];
      return Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          new Response(JSON.stringify(listing), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
        ),
      );
    }),
  );
  const layer = templateServiceLayer.pipe(
    Layer.provide(httpLayer),
    Layer.provide(mockCommandSettings({ workdir: "/" })),
    Layer.provide(mockOutput().layer),
    Layer.provide(BunServices.layer),
  );
  return { layer };
}

describe("bootstrap template service", () => {
  it.live("lists samples with a bearer header when settings carry GITHUB_TOKEN", () => {
    const s = setup({ githubToken: "gh-tok" });
    return Effect.gen(function* () {
      const service = yield* TemplateService;
      const samples = yield* service.listSamples;
      expect(samples).toEqual([SAMPLES.samples[0]]);
      expect(s.requests).toHaveLength(1);
      expect(s.requests[0]?.url).toBe(
        "https://api.github.com/repos/supabase-community/supabase-samples/contents/samples.json?ref=main",
      );
      expect(s.requests[0]?.headers["accept"]).toBe("application/vnd.github.v3+json");
      expect(s.requests[0]?.headers["authorization"]).toBe("Bearer gh-tok");
    }).pipe(Effect.provide(s.layer));
  });

  it.live("lists samples anonymously when no GITHUB_TOKEN is captured", () => {
    const s = setup();
    return Effect.gen(function* () {
      const service = yield* TemplateService;
      const samples = yield* service.listSamples;
      expect(samples).toEqual([SAMPLES.samples[0]]);
      expect(s.requests[0]?.headers["authorization"]).toBeUndefined();
    }).pipe(Effect.provide(s.layer));
  });

  it.live("fails with the unmarshal error when samples.json is not json", () => {
    const s = setup({ content: "not json" });
    return Effect.gen(function* () {
      const service = yield* TemplateService;
      const error = yield* Effect.flip(service.listSamples);
      expect(error).toBeInstanceOf(BootstrapTemplateListError);
      expect(error.message).toContain("failed to unmarshal samples:");
    }).pipe(Effect.provide(s.layer));
  });

  it.live("downloads a template tree below its root into the target directory", () => {
    const s = setupDownload({
      "examples/app": [
        { type: "file", path: "examples/app/a.txt", download_url: "https://files.test/a.txt" },
        { type: "dir", path: "examples/app/sub" },
      ],
      "examples/app/sub": [
        { type: "file", path: "examples/app/sub/b.txt", download_url: "https://files.test/b.txt" },
      ],
    });
    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const targetDir = yield* fs.makeTempDirectoryScoped({ prefix: "supabase-bootstrap-tpl-dl-" });
      const service = yield* TemplateService;
      yield* service.download("https://github.com/o/r/tree/main/examples/app", targetDir);
      expect(yield* fs.readFileString(path.join(targetDir, "a.txt"))).toBe("content of /a.txt");
      expect(yield* fs.readFileString(path.join(targetDir, "sub", "b.txt"))).toBe(
        "content of /b.txt",
      );
    }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(s.layer, BunServices.layer)));
  });

  it.live("rejects a listing entry that escapes the target directory", () => {
    const s = setupDownload({
      "examples/app": [
        { type: "file", path: "../escape.txt", download_url: "https://files.test/x" },
      ],
    });
    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const targetDir = yield* fs.makeTempDirectoryScoped({
        prefix: "supabase-bootstrap-tpl-esc-",
      });
      const service = yield* TemplateService;
      const error = yield* Effect.flip(
        service.download("https://github.com/o/r/tree/main/examples/app", targetDir),
      );
      expect(error).toBeInstanceOf(BootstrapTemplateDownloadError);
      expect(error.message).toContain("entry escapes target directory");
    }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(s.layer, BunServices.layer)));
  });

  it.live("rejects a file entry with no download url", () => {
    const s = setupDownload({
      "examples/app": [{ type: "file", path: "examples/app/big.bin", download_url: null }],
    });
    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const targetDir = yield* fs.makeTempDirectoryScoped({
        prefix: "supabase-bootstrap-tpl-nul-",
      });
      const service = yield* TemplateService;
      const error = yield* Effect.flip(
        service.download("https://github.com/o/r/tree/main/examples/app", targetDir),
      );
      expect(error).toBeInstanceOf(BootstrapTemplateDownloadError);
      expect(error.message).toContain("no download URL");
    }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(s.layer, BunServices.layer)));
  });
});
