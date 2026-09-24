import { describe, expect, test } from "bun:test";

import {
  copyImage,
  copyNatives,
  ensureEcrPublicRepo,
  fetchNatives,
  main,
  nativesFromEvent,
  uploadNativesS3,
  verifyDigest,
  type CommandResult,
  type RunCommand,
} from "./mirror-slim-image.ts";
import {
  InvalidPayloadError,
  checksumFor,
  digestReference,
  nativeFileNames,
  nativeObjectUrl,
  nativeTagPattern,
  nativeTripletDigests,
  parseNatives,
  validateMirrorDispatch,
} from "./slim-mirror-payload.ts";

const DIGEST = `sha256:${"a".repeat(64)}`;
const OTHER = `sha256:${"b".repeat(64)}`;

const ok = (stdout = ""): CommandResult => ({ ok: true, stdout, stderr: "" });
const fail = (stderr = "", stdout = ""): CommandResult => ({ ok: false, stdout, stderr });

describe("validateMirrorDispatch", () => {
  test("derives source and destination on workflow_dispatch", () => {
    expect(
      validateMirrorDispatch({
        eventName: "workflow_dispatch",
        service: "postgrest",
        version: "v16.2",
        digest: DIGEST,
        payloadSource: undefined,
        payloadDestination: undefined,
      }),
    ).toEqual({
      service: "postgrest",
      version: "v16.2",
      digest: DIGEST,
      source: "ghcr.io/supabase/cli/postgrest:v16.2",
      destination: "public.ecr.aws/supabase/cli/postgrest:v16.2",
    });
  });

  test("requires payload URLs to match derived refs on repository_dispatch", () => {
    expect(() =>
      validateMirrorDispatch({
        eventName: "repository_dispatch",
        service: "postgrest",
        version: "v16.2",
        digest: DIGEST,
        payloadSource: "ghcr.io/evil/cli/postgrest:v16.2",
        payloadDestination: "public.ecr.aws/supabase/cli/postgrest:v16.2",
      }),
    ).toThrow(InvalidPayloadError);
  });

  test("rejects a digest that is not sha256", () => {
    expect(() =>
      validateMirrorDispatch({
        eventName: "workflow_dispatch",
        service: "postgrest",
        version: "v16.2",
        digest: "sha256:nope",
        payloadSource: undefined,
        payloadDestination: undefined,
      }),
    ).toThrow(InvalidPayloadError);
  });
});

describe("parseNatives", () => {
  test("accepts an empty or missing list", () => {
    expect(parseNatives(undefined, "v16.2")).toEqual([]);
    expect(parseNatives(null, "v16.2")).toEqual([]);
    expect(parseNatives([], "v16.2")).toEqual([]);
  });

  test("rejects a platform image tag", () => {
    expect(() => parseNatives([{ tag: "v16.2-linux-arm64", digest: DIGEST }], "v16.2")).toThrow(
      InvalidPayloadError,
    );
  });

  test("keeps a matching native tag", () => {
    expect(parseNatives([{ tag: "v16.2-native-linux-arm64", digest: DIGEST }], "v16.2")).toEqual([
      { tag: "v16.2-native-linux-arm64", digest: DIGEST },
    ]);
    expect(nativeTagPattern("v16.2").test("v16.2-native-darwin-arm64")).toBe(true);
  });
});

describe("verifyDigest", () => {
  test("accepts a matching head", async () => {
    const run: RunCommand = async () => ok(`${DIGEST}\n`);
    await verifyDigest({
      reference: "ghcr.io/supabase/cli/postgrest:v16.2",
      digest: DIGEST,
      run,
      log: () => undefined,
    });
  });

  test("rejects a mismatch", async () => {
    const run: RunCommand = async () => ok(`${OTHER}\n`);
    await expect(
      verifyDigest({
        reference: "ghcr.io/supabase/cli/postgrest:v16.2",
        digest: DIGEST,
        run,
        log: () => undefined,
      }),
    ).rejects.toThrow(InvalidPayloadError);
  });

  test("re-reads a stale tag until it converges", async () => {
    const heads = [fail("not found [http 404]"), ok(`${OTHER}\n`), ok(`${DIGEST}\n`)];
    let reads = 0;
    const run: RunCommand = async () => heads[reads++] ?? fail("unexpected read");
    await verifyDigest({
      reference: "public.ecr.aws/supabase/cli/postgrest:v16.2",
      digest: DIGEST,
      run,
      attempts: 5,
      sleep: async () => undefined,
      log: () => undefined,
    });
    expect(reads).toBe(3);
  });

  test("reports the last mismatch once attempts are exhausted", async () => {
    let reads = 0;
    const run: RunCommand = async () => {
      reads++;
      return ok(`${OTHER}\n`);
    };
    await expect(
      verifyDigest({
        reference: "public.ecr.aws/supabase/cli/postgrest:v16.2",
        digest: DIGEST,
        run,
        attempts: 3,
        sleep: async () => undefined,
        log: () => undefined,
      }),
    ).rejects.toThrow(`resolves to ${OTHER}, expected ${DIGEST}`);
    expect(reads).toBe(3);
  });
});

describe("ensureEcrPublicRepo", () => {
  test("no-ops when the repository exists", async () => {
    const run: RunCommand = async () => ok();
    const logs: string[] = [];
    await ensureEcrPublicRepo({
      service: "postgrest",
      run,
      log: (message) => logs.push(message),
    });
    expect(logs).toEqual(["ECR Public repository cli/postgrest exists"]);
  });

  test("creates a missing repository", async () => {
    const run: RunCommand = async (argv) =>
      argv.includes("describe-repositories") ? fail("not found") : ok();
    const logs: string[] = [];
    await ensureEcrPublicRepo({
      service: "postgrest",
      run,
      log: (message) => logs.push(message),
    });
    expect(logs).toEqual(["created ECR Public repository cli/postgrest"]);
  });

  test("treats a create race as success", async () => {
    const run: RunCommand = async () => fail("RepositoryAlreadyExistsException");
    const logs: string[] = [];
    await ensureEcrPublicRepo({
      service: "auth",
      run,
      log: (message) => logs.push(message),
    });
    expect(logs).toEqual(["ECR Public repository cli/auth was created concurrently"]);
  });

  test("fails when create is denied", async () => {
    const run: RunCommand = async () => fail("AccessDenied");
    await expect(
      ensureEcrPublicRepo({ service: "postgrest", run, log: () => undefined }),
    ).rejects.toThrow(/CreateRepository/);
  });
});

describe("copyImage", () => {
  test("copies by digest with referrers", async () => {
    const calls: string[][] = [];
    const run: RunCommand = async (argv) => {
      calls.push([...argv]);
      return ok();
    };
    await copyImage({
      source: "ghcr.io/supabase/cli/postgrest:v16.2",
      destination: "public.ecr.aws/supabase/cli/postgrest:v16.2",
      digest: DIGEST,
      run,
    });
    expect(calls).toEqual([
      [
        "regctl",
        "image",
        "copy",
        "--referrers",
        "--digest-tags",
        digestReference("ghcr.io/supabase/cli/postgrest:v16.2", DIGEST),
        "public.ecr.aws/supabase/cli/postgrest:v16.2",
      ],
    ]);
  });
});

describe("copyNatives", () => {
  test("copies each matching source and continues after a missing tag", async () => {
    const calls: string[][] = [];
    const run: RunCommand = async (argv) => {
      calls.push([...argv]);
      if (argv[1] === "manifest" && String(argv[3]).includes("linux-amd64")) return fail("missing");
      if (argv[1] === "manifest") return ok(`${DIGEST}\n`);
      return ok();
    };
    const warnings: string[] = [];
    const failed = await copyNatives({
      service: "postgrest",
      natives: [
        { tag: "v16.2-native-linux-arm64", digest: DIGEST },
        { tag: "v16.2-native-linux-amd64", digest: DIGEST },
      ],
      run,
      log: (message) => {
        warnings.push(message);
      },
    });
    expect(failed).toBe(1);
    expect(calls).toEqual([
      ["regctl", "manifest", "head", "ghcr.io/supabase/cli/postgrest:v16.2-native-linux-arm64"],
      [
        "regctl",
        "image",
        "copy",
        `ghcr.io/supabase/cli/postgrest@${DIGEST}`,
        "public.ecr.aws/supabase/cli/postgrest:v16.2-native-linux-arm64",
      ],
      ["regctl", "manifest", "head", "ghcr.io/supabase/cli/postgrest:v16.2-native-linux-amd64"],
    ]);
    expect(warnings.some((line) => line.includes("linux-amd64 is missing"))).toBe(true);
  });

  test("skips a digest mismatch without copying", async () => {
    const calls: string[][] = [];
    const run: RunCommand = async (argv) => {
      calls.push([...argv]);
      return argv[1] === "manifest" ? ok(`${OTHER}\n`) : fail("should not copy");
    };
    const failed = await copyNatives({
      service: "postgrest",
      natives: [{ tag: "v16.2-native-linux-arm64", digest: DIGEST }],
      run,
      log: () => undefined,
    });
    expect(failed).toBe(1);
    expect(calls).toEqual([
      ["regctl", "manifest", "head", "ghcr.io/supabase/cli/postgrest:v16.2-native-linux-arm64"],
    ]);
  });
});

describe("main", () => {
  test("validate writes GitHub outputs", async () => {
    const fields: Record<string, string> = {};
    const code = await main(["validate"], {
      env: {
        EVENT_NAME: "workflow_dispatch",
        SERVICE: "postgrest",
        VERSION: "v16.2",
        DIGEST,
      },
      run: async () => fail("unused"),
      writeOutput: (next) => {
        Object.assign(fields, next);
      },
    });
    expect(code).toBe(0);
    expect(fields["destination"]).toBe("public.ecr.aws/supabase/cli/postgrest:v16.2");
  });

  test("verify-digest re-reads up to ATTEMPTS times", async () => {
    const heads = [ok(`${OTHER}\n`), ok(`${DIGEST}\n`)];
    let reads = 0;
    const code = await main(["verify-digest"], {
      env: {
        REFERENCE: "public.ecr.aws/supabase/cli/postgrest:v16.2",
        DIGEST,
        ATTEMPTS: "2",
      },
      run: async () => heads[reads++] ?? fail("unexpected read"),
      sleep: async () => undefined,
      log: () => undefined,
    });
    expect(code).toBe(0);
    expect(reads).toBe(2);
  });

  test("copy-natives no-ops without a dispatch payload", async () => {
    const logs: string[] = [];
    const code = await main(["copy-natives"], {
      env: { EVENT_NAME: "workflow_dispatch", SERVICE: "postgrest", VERSION: "v16.2" },
      run: async () => fail("unused"),
      log: (message) => logs.push(message),
    });
    expect(code).toBe(0);
    expect(logs).toEqual(["no native artifacts in payload"]);
  });

  test("copy-natives reads natives from the dispatch event", async () => {
    const natives = await nativesFromEvent(
      { EVENT_NAME: "repository_dispatch", GITHUB_EVENT_PATH: "event.json" },
      "v16.2",
      async () =>
        JSON.stringify({
          client_payload: { natives: [{ tag: "v16.2-native-linux-arm64", digest: DIGEST }] },
        }),
    );
    expect(natives).toEqual([{ tag: "v16.2-native-linux-arm64", digest: DIGEST }]);
  });
});

const ARCHIVE_BLOB = `sha256:${"1".repeat(64)}`;
const MANIFEST_BLOB = `sha256:${"2".repeat(64)}`;
const CHECKSUM_BLOB = `sha256:${"3".repeat(64)}`;
const ARCHIVE_SHA = "d".repeat(64);

const ociManifest = JSON.stringify({
  layers: [
    { mediaType: "application/vnd.supabase.slim.archive.v1.tar+zstd", digest: ARCHIVE_BLOB },
    { mediaType: "application/vnd.supabase.slim.manifest.v1+json", digest: MANIFEST_BLOB },
    { mediaType: "application/vnd.supabase.slim.checksum.v1", digest: CHECKSUM_BLOB },
  ],
});

describe("native triplet helpers", () => {
  test("keeps release asset names as object keys", () => {
    expect(nativeFileNames("postgrest", "v16.2", "linux-arm64")).toEqual({
      archive: "postgrest-v16.2-linux-arm64.tar.zst",
      manifest: "postgrest-v16.2-linux-arm64.manifest.json",
      checksum: "postgrest-v16.2-linux-arm64.SHA256SUMS",
    });
    expect(nativeObjectUrl("postgrest", "v16.2", "postgrest-v16.2-linux-arm64.tar.zst")).toBe(
      "https://supabase-cli-artifacts.s3.us-east-1.amazonaws.com/postgrest/v16.2/postgrest-v16.2-linux-arm64.tar.zst",
    );
  });

  test("selects triplet blobs by media type and rejects incomplete artifacts", () => {
    expect(nativeTripletDigests(ociManifest)).toEqual({
      archive: ARCHIVE_BLOB,
      manifest: MANIFEST_BLOB,
      checksum: CHECKSUM_BLOB,
    });
    expect(
      nativeTripletDigests(JSON.stringify({ layers: [{ mediaType: "x", digest: ARCHIVE_BLOB }] })),
    ).toBeUndefined();
  });

  test("matches sums lines by archive name", () => {
    const sums = `${ARCHIVE_SHA.toUpperCase()}  postgrest-v16.2-linux-arm64.tar.zst\n`;
    expect(checksumFor(sums, "postgrest-v16.2-linux-arm64.tar.zst")).toBe(ARCHIVE_SHA);
    expect(checksumFor(sums, "postgrest-v16.2-linux-amd64.tar.zst")).toBeUndefined();
  });
});

describe("fetchNatives", () => {
  const io = (
    overrides: { readonly sha?: string; readonly manifest?: string; readonly head?: string } = {},
  ) => {
    const files: Record<string, string> = {};
    const calls: string[][] = [];
    const run: RunCommand = async (argv) => {
      calls.push([...argv]);
      if (argv[1] === "manifest" && argv[2] === "head") return ok(`${overrides.head ?? DIGEST}\n`);
      return argv[1] === "manifest" ? ok(ociManifest) : fail("unexpected");
    };
    return {
      calls,
      run,
      runToFile: async (argv: ReadonlyArray<string>, outputPath: string) => {
        calls.push([...argv, `> ${outputPath}`]);
        const digest = argv[4];
        files[outputPath] =
          digest === MANIFEST_BLOB
            ? (overrides.manifest ??
              JSON.stringify({ service: "postgrest", version: "v16.2", target: "linux-arm64" }))
            : digest === CHECKSUM_BLOB
              ? `${ARCHIVE_SHA}  postgrest-v16.2-linux-arm64.tar.zst\n`
              : "archive-bytes";
        return ok();
      },
      readText: async (path: string) => files[path] ?? "",
      sha256File: async () => overrides.sha ?? ARCHIVE_SHA,
      mkdir: () => undefined,
      log: () => undefined,
    };
  };

  test("downloads the triplet under release asset names and verifies it", async () => {
    const deps = io();
    const fetched = await fetchNatives({
      service: "postgrest",
      version: "v16.2",
      natives: [{ tag: "v16.2-native-linux-arm64", digest: DIGEST }],
      outputDir: "/tmp/natives",
      ...deps,
    });
    expect(fetched).toEqual([
      { target: "linux-arm64", files: nativeFileNames("postgrest", "v16.2", "linux-arm64") },
    ]);
    expect(deps.calls[0]).toEqual([
      "regctl",
      "manifest",
      "head",
      "ghcr.io/supabase/cli/postgrest:v16.2-native-linux-arm64",
    ]);
    expect(deps.calls[1]).toEqual([
      "regctl",
      "manifest",
      "get",
      `ghcr.io/supabase/cli/postgrest@${DIGEST}`,
      "--format",
      "raw-body",
    ]);
    expect(deps.calls[2]).toEqual([
      "regctl",
      "blob",
      "get",
      "ghcr.io/supabase/cli/postgrest",
      ARCHIVE_BLOB,
      "> /tmp/natives/linux-arm64/postgrest-v16.2-linux-arm64.tar.zst",
    ]);
  });

  test("skips a native whose tag no longer resolves to the dispatched digest", async () => {
    const deps = io({ head: OTHER });
    const fetched = await fetchNatives({
      service: "postgrest",
      version: "v16.2",
      natives: [{ tag: "v16.2-native-linux-arm64", digest: DIGEST }],
      outputDir: "/tmp/natives",
      ...deps,
    });
    expect(fetched).toEqual([]);
    expect(deps.calls).toHaveLength(1);
  });

  test("keeps the first entry for a repeated target and never refetches it", async () => {
    const deps = io();
    const fetched = await fetchNatives({
      service: "postgrest",
      version: "v16.2",
      natives: [
        { tag: "v16.2-native-linux-arm64", digest: DIGEST },
        { tag: "v16.2-native-linux-arm64", digest: OTHER },
      ],
      outputDir: "/tmp/natives",
      ...deps,
    });
    expect(fetched.map((item) => item.target)).toEqual(["linux-arm64"]);
    expect(deps.calls.filter((argv) => argv[1] === "manifest" && argv[2] === "head")).toHaveLength(
      1,
    );
  });

  test("drops a target whose manifest is not JSON", async () => {
    const fetched = await fetchNatives({
      service: "postgrest",
      version: "v16.2",
      natives: [{ tag: "v16.2-native-linux-arm64", digest: DIGEST }],
      outputDir: "/tmp/natives",
      ...io({ manifest: "{not json" }),
    });
    expect(fetched).toEqual([]);
    expect(nativeTripletDigests("<html>")).toBeUndefined();
  });

  test("drops a target whose archive does not match its sums file", async () => {
    const fetched = await fetchNatives({
      service: "postgrest",
      version: "v16.2",
      natives: [{ tag: "v16.2-native-linux-arm64", digest: DIGEST }],
      outputDir: "/tmp/natives",
      ...io({ sha: "e".repeat(64) }),
    });
    expect(fetched).toEqual([]);
  });

  test("drops a target whose manifest names another release", async () => {
    const fetched = await fetchNatives({
      service: "postgrest",
      version: "v16.2",
      natives: [{ tag: "v16.2-native-linux-arm64", digest: DIGEST }],
      outputDir: "/tmp/natives",
      ...io({
        manifest: JSON.stringify({ service: "postgrest", version: "v16.1", target: "linux-arm64" }),
      }),
    });
    expect(fetched).toEqual([]);
  });
});

describe("uploadNativesS3", () => {
  const fetched = [
    { target: "linux-arm64", files: nativeFileNames("postgrest", "v16.2", "linux-arm64") },
  ];

  test("copies archive, manifest, then sums and verifies anonymous reads", async () => {
    const calls: string[][] = [];
    const checked: string[] = [];
    await uploadNativesS3({
      service: "postgrest",
      version: "v16.2",
      inputDir: "/tmp/natives",
      fetched,
      run: async (argv) => {
        calls.push([...argv]);
        return ok();
      },
      httpStatus: async (url, method) => {
        checked.push(`${method} ${url}`);
        return url.endsWith("/") ? 403 : 200;
      },
      log: () => undefined,
    });
    expect(calls.map((argv) => argv.at(-1))).toEqual([
      "s3://supabase-cli-artifacts/postgrest/v16.2/postgrest-v16.2-linux-arm64.tar.zst",
      "s3://supabase-cli-artifacts/postgrest/v16.2/postgrest-v16.2-linux-arm64.manifest.json",
      "s3://supabase-cli-artifacts/postgrest/v16.2/postgrest-v16.2-linux-arm64.SHA256SUMS",
    ]);
    expect(calls[0]).toContain("/tmp/natives/linux-arm64/postgrest-v16.2-linux-arm64.tar.zst");
    expect(calls.every((argv) => argv[1] === "s3" && argv[2] === "cp")).toBe(true);
    expect(checked).toEqual([
      "HEAD https://supabase-cli-artifacts.s3.us-east-1.amazonaws.com/postgrest/v16.2/postgrest-v16.2-linux-arm64.tar.zst",
      "HEAD https://supabase-cli-artifacts.s3.us-east-1.amazonaws.com/postgrest/v16.2/postgrest-v16.2-linux-arm64.manifest.json",
      "HEAD https://supabase-cli-artifacts.s3.us-east-1.amazonaws.com/postgrest/v16.2/postgrest-v16.2-linux-arm64.SHA256SUMS",
      "GET https://supabase-cli-artifacts.s3.us-east-1.amazonaws.com/",
    ]);
  });

  test("fails when an object is not publicly readable", async () => {
    await expect(
      uploadNativesS3({
        service: "postgrest",
        version: "v16.2",
        inputDir: "/tmp/natives",
        fetched,
        run: async () => ok(),
        httpStatus: async () => 403,
        log: () => undefined,
      }),
    ).rejects.toThrow(/not publicly readable/);
  });

  test("fails when the bucket starts listing", async () => {
    await expect(
      uploadNativesS3({
        service: "postgrest",
        version: "v16.2",
        inputDir: "/tmp/natives",
        fetched,
        run: async () => ok(),
        httpStatus: async () => 200,
        log: () => undefined,
      }),
    ).rejects.toThrow(/listing must stay closed/);
  });
});

describe("main fetch-natives", () => {
  test("writes count=0 without a dispatch payload", async () => {
    const fields: Record<string, string> = {};
    const code = await main(["fetch-natives"], {
      env: {
        EVENT_NAME: "workflow_dispatch",
        SERVICE: "postgrest",
        VERSION: "v16.2",
        OUTPUT_DIR: "/tmp/natives",
      },
      run: async () => fail("unused"),
      log: () => undefined,
      writeOutput: (next) => {
        Object.assign(fields, next);
      },
    });
    expect(code).toBe(0);
    expect(fields).toEqual({ count: "0", targets: "" });
  });

  test("exits 1 when the payload names natives but none can be verified", async () => {
    const fields: Record<string, string> = {};
    const event = JSON.stringify({
      client_payload: { natives: [{ tag: "v16.2-native-linux-arm64", digest: DIGEST }] },
    });
    const code = await main(["fetch-natives"], {
      env: {
        EVENT_NAME: "repository_dispatch",
        GITHUB_EVENT_PATH: "/tmp/event.json",
        SERVICE: "postgrest",
        VERSION: "v16.2",
        OUTPUT_DIR: "/tmp/natives",
      },
      run: async () => fail("manifest unknown"),
      readText: async () => event,
      log: () => undefined,
      writeOutput: (next) => {
        Object.assign(fields, next);
      },
    });
    expect(code).toBe(1);
    expect(fields).toEqual({ count: "0", targets: "" });
  });
});

describe("main upload-natives-s3", () => {
  test("uploads every target listed in TARGETS", async () => {
    const uploaded: string[] = [];
    const code = await main(["upload-natives-s3"], {
      env: {
        SERVICE: "postgrest",
        VERSION: "v16.2",
        INPUT_DIR: "/tmp/natives",
        TARGETS: "linux-arm64, darwin-arm64",
      },
      run: async (argv) => {
        uploaded.push(String(argv.at(-1)));
        return ok();
      },
      httpStatus: async (url) => (url.endsWith("/") ? 403 : 200),
      log: () => undefined,
    });
    expect(code).toBe(0);
    expect(uploaded).toEqual([
      "s3://supabase-cli-artifacts/postgrest/v16.2/postgrest-v16.2-linux-arm64.tar.zst",
      "s3://supabase-cli-artifacts/postgrest/v16.2/postgrest-v16.2-linux-arm64.manifest.json",
      "s3://supabase-cli-artifacts/postgrest/v16.2/postgrest-v16.2-linux-arm64.SHA256SUMS",
      "s3://supabase-cli-artifacts/postgrest/v16.2/postgrest-v16.2-darwin-arm64.tar.zst",
      "s3://supabase-cli-artifacts/postgrest/v16.2/postgrest-v16.2-darwin-arm64.manifest.json",
      "s3://supabase-cli-artifacts/postgrest/v16.2/postgrest-v16.2-darwin-arm64.SHA256SUMS",
    ]);
  });
});
