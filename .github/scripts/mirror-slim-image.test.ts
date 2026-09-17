import { describe, expect, test } from "bun:test";

import {
  copyImage,
  copyNatives,
  ensureEcrPublicRepo,
  main,
  nativesFromEvent,
  verifyDigest,
  type CommandResult,
  type RunCommand,
} from "./mirror-slim-image.ts";
import {
  InvalidPayloadError,
  digestReference,
  nativeTagPattern,
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
