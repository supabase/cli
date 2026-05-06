import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, inject, test } from "vitest";
import { runParity } from "@supabase/cli-test-helpers";
import { testBehaviour } from "./test-context.ts";
import { ACCESS_TOKEN, isRecording } from "./env.ts";

const BUCKET = "cli-e2e-bucket";
const LOCAL_FLAGS = ["--experimental", "--local"];

function setupStorageWorkspace(dir: string, relayUrl: string): void {
  mkdirSync(join(dir, "supabase"), { recursive: true });
  writeFileSync(
    join(dir, "supabase", "config.toml"),
    ['project_id = "test-project"', "", "[api]", `external_url = "${relayUrl}"`].join("\n"),
  );
  writeFileSync(join(dir, "upload.txt"), "test upload content");
}

type FailureType = "NON_AUTH" | "RATE_LIMIT";

const FAILURE_PRESETS: Record<FailureType, { status: number; body: { message: string } }> = {
  NON_AUTH: { status: 401, body: { message: "Invalid token" } },
  RATE_LIMIT: { status: 429, body: { message: "Too Many Requests" } },
};

function testParityStorage(cmd: string[], opts?: { failureType?: FailureType }): void {
  const label = opts?.failureType
    ? `parity: ${cmd.join(" ")} [${opts.failureType}]`
    : `parity: ${cmd.join(" ")}`;

  test.skipIf(isRecording)(label, async () => {
    const serverUrl = inject("replayServerUrl") as string;
    if (opts?.failureType) {
      await fetch(`${serverUrl}/_ctrl/error-all`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(FAILURE_PRESETS[opts.failureType]),
      });
    }
    try {
      await runParity(
        {
          apiUrl: serverUrl,
          accessToken: ACCESS_TOKEN,
          workspaceSetup: (dir) => setupStorageWorkspace(dir, serverUrl),
        },
        cmd,
      );
    } finally {
      if (opts?.failureType) {
        await fetch(`${serverUrl}/_ctrl/overrides`, { method: "DELETE" });
      }
    }
  });
}

interface RequestEntry {
  method: string;
  pathname: string;
  headers: Record<string, string>;
  body: unknown;
}

async function getRequestLog(apiUrl: string): Promise<RequestEntry[]> {
  const res = await fetch(`${apiUrl}/_ctrl/requests`);
  return res.json() as Promise<RequestEntry[]>;
}

async function injectGlobalError(apiUrl: string, status: number, message: string): Promise<void> {
  await fetch(`${apiUrl}/_ctrl/error-all`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ status, body: { message } }),
  });
}

async function clearOverrides(apiUrl: string): Promise<void> {
  await fetch(`${apiUrl}/_ctrl/overrides`, { method: "DELETE" });
}

// ---------------------------------------------------------------------------
// storage ls
// ---------------------------------------------------------------------------

describe("storage ls", () => {
  testBehaviour("lists objects in bucket", async ({ workspace, run, apiUrl }) => {
    setupStorageWorkspace(workspace.path, apiUrl);
    const result = await run(["storage", "ls", ...LOCAL_FLAGS, `ss:///${BUCKET}/`]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("hello.txt");
    const requests = await getRequestLog(apiUrl);
    expect(
      requests.some(
        (r) => r.method === "POST" && r.pathname === `/storage/v1/object/list/${BUCKET}`,
      ),
    ).toBe(true);
  });

  testBehaviour("lists objects recursively", async ({ workspace, run, apiUrl }) => {
    setupStorageWorkspace(workspace.path, apiUrl);
    const result = await run(["storage", "ls", ...LOCAL_FLAGS, "-r", `ss:///${BUCKET}/`]);
    expect(result.exitCode).toBe(0);
    const requests = await getRequestLog(apiUrl);
    expect(
      requests.some(
        (r) => r.method === "POST" && r.pathname === `/storage/v1/object/list/${BUCKET}`,
      ),
    ).toBe(true);
  });

  testBehaviour("exits 1 on 401", async ({ workspace, run, apiUrl }) => {
    setupStorageWorkspace(workspace.path, apiUrl);
    await injectGlobalError(apiUrl, 401, "Invalid token");
    const result = await run(["storage", "ls", ...LOCAL_FLAGS, `ss:///${BUCKET}/`]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Invalid token");
    await clearOverrides(apiUrl);
  });

  testBehaviour("exits 1 on 403", async ({ workspace, run, apiUrl }) => {
    setupStorageWorkspace(workspace.path, apiUrl);
    await injectGlobalError(apiUrl, 403, "Forbidden");
    const result = await run(["storage", "ls", ...LOCAL_FLAGS, `ss:///${BUCKET}/`]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr.length).toBeGreaterThan(0);
    await clearOverrides(apiUrl);
  });

  testBehaviour("exits 1 on 429", async ({ workspace, run, apiUrl }) => {
    setupStorageWorkspace(workspace.path, apiUrl);
    await injectGlobalError(apiUrl, 429, "Too Many Requests");
    const result = await run(["storage", "ls", ...LOCAL_FLAGS, `ss:///${BUCKET}/`]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr.length).toBeGreaterThan(0);
    await clearOverrides(apiUrl);
  });

  testBehaviour("exits 1 on 500", async ({ workspace, run, apiUrl }) => {
    setupStorageWorkspace(workspace.path, apiUrl);
    await injectGlobalError(apiUrl, 500, "Internal Server Error");
    const result = await run(["storage", "ls", ...LOCAL_FLAGS, `ss:///${BUCKET}/`]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr.length).toBeGreaterThan(0);
    await clearOverrides(apiUrl);
  });

  testParityStorage(["storage", "ls", ...LOCAL_FLAGS, `ss:///${BUCKET}/`]);
  testParityStorage(["storage", "ls", ...LOCAL_FLAGS, `ss:///${BUCKET}/`], {
    failureType: "NON_AUTH",
  });
});

// ---------------------------------------------------------------------------
// storage cp
// ---------------------------------------------------------------------------

describe("storage cp", () => {
  testBehaviour("uploads local file to storage", async ({ workspace, run, apiUrl }) => {
    setupStorageWorkspace(workspace.path, apiUrl);
    const result = await run([
      "storage",
      "cp",
      ...LOCAL_FLAGS,
      "upload.txt",
      `ss:///${BUCKET}/upload.txt`,
    ]);
    expect(result.exitCode).toBe(0);
    const requests = await getRequestLog(apiUrl);
    expect(
      requests.some(
        (r) => r.method === "POST" && r.pathname === `/storage/v1/object/${BUCKET}/upload.txt`,
      ),
    ).toBe(true);
  });

  testBehaviour("passes --cache-control header on upload", async ({ workspace, run, apiUrl }) => {
    setupStorageWorkspace(workspace.path, apiUrl);
    const result = await run([
      "storage",
      "cp",
      ...LOCAL_FLAGS,
      "--cache-control",
      "no-cache",
      "upload.txt",
      `ss:///${BUCKET}/cached.txt`,
    ]);
    expect(result.exitCode).toBe(0);
    const requests = await getRequestLog(apiUrl);
    const uploadReq = requests.find(
      (r) => r.method === "POST" && r.pathname.startsWith(`/storage/v1/object/${BUCKET}/`),
    );
    expect(uploadReq).toBeDefined();
    expect(uploadReq?.headers["cache-control"]).toBe("no-cache");
  });

  testBehaviour("passes --content-type header on upload", async ({ workspace, run, apiUrl }) => {
    setupStorageWorkspace(workspace.path, apiUrl);
    const result = await run([
      "storage",
      "cp",
      ...LOCAL_FLAGS,
      "--content-type",
      "application/json",
      "upload.txt",
      `ss:///${BUCKET}/typed.txt`,
    ]);
    expect(result.exitCode).toBe(0);
    const requests = await getRequestLog(apiUrl);
    const uploadReq = requests.find(
      (r) => r.method === "POST" && r.pathname.startsWith(`/storage/v1/object/${BUCKET}/`),
    );
    expect(uploadReq).toBeDefined();
    expect(uploadReq?.headers["content-type"]).toContain("application/json");
  });

  testBehaviour("exits 1 when source file not found", async ({ workspace, run, apiUrl }) => {
    setupStorageWorkspace(workspace.path, apiUrl);
    const result = await run([
      "storage",
      "cp",
      ...LOCAL_FLAGS,
      "nonexistent.txt",
      `ss:///${BUCKET}/x.txt`,
    ]);
    expect(result.exitCode).toBe(1);
  });

  testBehaviour("exits 1 on 401", async ({ workspace, run, apiUrl }) => {
    setupStorageWorkspace(workspace.path, apiUrl);
    await injectGlobalError(apiUrl, 401, "Invalid token");
    const result = await run([
      "storage",
      "cp",
      ...LOCAL_FLAGS,
      "upload.txt",
      `ss:///${BUCKET}/upload.txt`,
    ]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Invalid token");
    await clearOverrides(apiUrl);
  });

  testBehaviour("exits 1 on 403", async ({ workspace, run, apiUrl }) => {
    setupStorageWorkspace(workspace.path, apiUrl);
    await injectGlobalError(apiUrl, 403, "Forbidden");
    const result = await run([
      "storage",
      "cp",
      ...LOCAL_FLAGS,
      "upload.txt",
      `ss:///${BUCKET}/upload.txt`,
    ]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr.length).toBeGreaterThan(0);
    await clearOverrides(apiUrl);
  });

  testBehaviour("exits 1 on 429", async ({ workspace, run, apiUrl }) => {
    setupStorageWorkspace(workspace.path, apiUrl);
    await injectGlobalError(apiUrl, 429, "Too Many Requests");
    const result = await run([
      "storage",
      "cp",
      ...LOCAL_FLAGS,
      "upload.txt",
      `ss:///${BUCKET}/upload.txt`,
    ]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr.length).toBeGreaterThan(0);
    await clearOverrides(apiUrl);
  });

  testBehaviour("exits 1 on 500", async ({ workspace, run, apiUrl }) => {
    setupStorageWorkspace(workspace.path, apiUrl);
    await injectGlobalError(apiUrl, 500, "Internal Server Error");
    const result = await run([
      "storage",
      "cp",
      ...LOCAL_FLAGS,
      "upload.txt",
      `ss:///${BUCKET}/upload.txt`,
    ]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr.length).toBeGreaterThan(0);
    await clearOverrides(apiUrl);
  });

  testBehaviour("downloads file from storage", async ({ workspace, run, apiUrl }) => {
    setupStorageWorkspace(workspace.path, apiUrl);
    const result = await run([
      "storage",
      "cp",
      ...LOCAL_FLAGS,
      `ss:///${BUCKET}/hello.txt`,
      "hello-download.txt",
    ]);
    expect(result.exitCode).toBe(0);
  });

  // Parity: same paths as testBehaviour fixtures so the recorded/ entries match.
  testParityStorage(["storage", "cp", ...LOCAL_FLAGS, "upload.txt", `ss:///${BUCKET}/upload.txt`]);
  testParityStorage(["storage", "cp", ...LOCAL_FLAGS, "upload.txt", `ss:///${BUCKET}/upload.txt`], {
    failureType: "NON_AUTH",
  });
  testParityStorage([
    "storage",
    "cp",
    ...LOCAL_FLAGS,
    `ss:///${BUCKET}/hello.txt`,
    "hello-download.txt",
  ]);
});

// ---------------------------------------------------------------------------
// storage mv
// ---------------------------------------------------------------------------

describe("storage mv", () => {
  testBehaviour("moves file within bucket", async ({ workspace, run, apiUrl }) => {
    setupStorageWorkspace(workspace.path, apiUrl);
    // Upload source file so the move has something to move in staging.
    await run(["storage", "cp", ...LOCAL_FLAGS, "upload.txt", `ss:///${BUCKET}/mv-source.txt`]);
    const result = await run([
      "storage",
      "mv",
      ...LOCAL_FLAGS,
      `ss:///${BUCKET}/mv-source.txt`,
      `ss:///${BUCKET}/mv-dest.txt`,
    ]);
    expect(result.exitCode).toBe(0);
    const requests = await getRequestLog(apiUrl);
    const moveReq = requests.find(
      (r) => r.method === "POST" && r.pathname === "/storage/v1/object/move",
    );
    expect(moveReq).toBeDefined();
    expect(moveReq?.body).toMatchObject({
      bucketId: BUCKET,
      sourceKey: "mv-source.txt",
      destinationKey: "mv-dest.txt",
    });
  });

  testBehaviour("exits 1 on 401", async ({ workspace, run, apiUrl }) => {
    setupStorageWorkspace(workspace.path, apiUrl);
    await injectGlobalError(apiUrl, 401, "Invalid token");
    const result = await run([
      "storage",
      "mv",
      ...LOCAL_FLAGS,
      `ss:///${BUCKET}/a.txt`,
      `ss:///${BUCKET}/b.txt`,
    ]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Invalid token");
    await clearOverrides(apiUrl);
  });

  testBehaviour("exits 1 on 403", async ({ workspace, run, apiUrl }) => {
    setupStorageWorkspace(workspace.path, apiUrl);
    await injectGlobalError(apiUrl, 403, "Forbidden");
    const result = await run([
      "storage",
      "mv",
      ...LOCAL_FLAGS,
      `ss:///${BUCKET}/a.txt`,
      `ss:///${BUCKET}/b.txt`,
    ]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr.length).toBeGreaterThan(0);
    await clearOverrides(apiUrl);
  });

  testBehaviour("exits 1 on 429", async ({ workspace, run, apiUrl }) => {
    setupStorageWorkspace(workspace.path, apiUrl);
    await injectGlobalError(apiUrl, 429, "Too Many Requests");
    const result = await run([
      "storage",
      "mv",
      ...LOCAL_FLAGS,
      `ss:///${BUCKET}/a.txt`,
      `ss:///${BUCKET}/b.txt`,
    ]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr.length).toBeGreaterThan(0);
    await clearOverrides(apiUrl);
  });

  testBehaviour("exits 1 on 500", async ({ workspace, run, apiUrl }) => {
    setupStorageWorkspace(workspace.path, apiUrl);
    await injectGlobalError(apiUrl, 500, "Internal Server Error");
    const result = await run([
      "storage",
      "mv",
      ...LOCAL_FLAGS,
      `ss:///${BUCKET}/a.txt`,
      `ss:///${BUCKET}/b.txt`,
    ]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr.length).toBeGreaterThan(0);
    await clearOverrides(apiUrl);
  });

  // Parity: same src/dst as testBehaviour "moves file within bucket" so recorded/ fixture body matches.
  testParityStorage([
    "storage",
    "mv",
    ...LOCAL_FLAGS,
    `ss:///${BUCKET}/mv-source.txt`,
    `ss:///${BUCKET}/mv-dest.txt`,
  ]);
  testParityStorage(
    [
      "storage",
      "mv",
      ...LOCAL_FLAGS,
      `ss:///${BUCKET}/mv-source.txt`,
      `ss:///${BUCKET}/mv-dest.txt`,
    ],
    { failureType: "NON_AUTH" },
  );
});

// ---------------------------------------------------------------------------
// storage rm
// ---------------------------------------------------------------------------

describe("storage rm", () => {
  testBehaviour("removes a file from storage", async ({ workspace, run, apiUrl }) => {
    setupStorageWorkspace(workspace.path, apiUrl);
    // Upload the file to remove.
    await run(["storage", "cp", ...LOCAL_FLAGS, "upload.txt", `ss:///${BUCKET}/rm-target.txt`]);
    const result = await run([
      "storage",
      "rm",
      "--yes",
      ...LOCAL_FLAGS,
      `ss:///${BUCKET}/rm-target.txt`,
    ]);
    expect(result.exitCode).toBe(0);
    const requests = await getRequestLog(apiUrl);
    const rmReq = requests.find(
      (r) => r.method === "DELETE" && r.pathname === `/storage/v1/object/${BUCKET}`,
    );
    expect(rmReq).toBeDefined();
    expect(rmReq?.body).toMatchObject({ prefixes: ["rm-target.txt"] });
  });

  testBehaviour("removes multiple files", async ({ workspace, run, apiUrl }) => {
    setupStorageWorkspace(workspace.path, apiUrl);
    writeFileSync(join(workspace.path, "file2.txt"), "second file");
    await run(["storage", "cp", ...LOCAL_FLAGS, "upload.txt", `ss:///${BUCKET}/rm-a.txt`]);
    await run(["storage", "cp", ...LOCAL_FLAGS, "file2.txt", `ss:///${BUCKET}/rm-b.txt`]);
    const result = await run([
      "storage",
      "rm",
      "--yes",
      ...LOCAL_FLAGS,
      `ss:///${BUCKET}/rm-a.txt`,
      `ss:///${BUCKET}/rm-b.txt`,
    ]);
    expect(result.exitCode).toBe(0);
    const requests = await getRequestLog(apiUrl);
    const rmReq = requests.find(
      (r) => r.method === "DELETE" && r.pathname === `/storage/v1/object/${BUCKET}`,
    );
    expect(rmReq).toBeDefined();
    expect(rmReq?.body).toMatchObject({ prefixes: ["rm-a.txt", "rm-b.txt"] });
  });

  testBehaviour("exits 1 on 401", async ({ workspace, run, apiUrl }) => {
    setupStorageWorkspace(workspace.path, apiUrl);
    await injectGlobalError(apiUrl, 401, "Invalid token");
    const result = await run([
      "storage",
      "rm",
      "--yes",
      ...LOCAL_FLAGS,
      `ss:///${BUCKET}/file.txt`,
    ]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Invalid token");
    await clearOverrides(apiUrl);
  });

  testBehaviour("exits 1 on 403", async ({ workspace, run, apiUrl }) => {
    setupStorageWorkspace(workspace.path, apiUrl);
    await injectGlobalError(apiUrl, 403, "Forbidden");
    const result = await run([
      "storage",
      "rm",
      "--yes",
      ...LOCAL_FLAGS,
      `ss:///${BUCKET}/file.txt`,
    ]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr.length).toBeGreaterThan(0);
    await clearOverrides(apiUrl);
  });

  testBehaviour("exits 1 on 429", async ({ workspace, run, apiUrl }) => {
    setupStorageWorkspace(workspace.path, apiUrl);
    await injectGlobalError(apiUrl, 429, "Too Many Requests");
    const result = await run([
      "storage",
      "rm",
      "--yes",
      ...LOCAL_FLAGS,
      `ss:///${BUCKET}/file.txt`,
    ]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr.length).toBeGreaterThan(0);
    await clearOverrides(apiUrl);
  });

  testBehaviour("exits 1 on 500", async ({ workspace, run, apiUrl }) => {
    setupStorageWorkspace(workspace.path, apiUrl);
    await injectGlobalError(apiUrl, 500, "Internal Server Error");
    const result = await run([
      "storage",
      "rm",
      "--yes",
      ...LOCAL_FLAGS,
      `ss:///${BUCKET}/file.txt`,
    ]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr.length).toBeGreaterThan(0);
    await clearOverrides(apiUrl);
  });

  // Parity: same path as testBehaviour "removes a file from storage" so recorded/ fixture body matches.
  testParityStorage(["storage", "rm", "--yes", ...LOCAL_FLAGS, `ss:///${BUCKET}/rm-target.txt`]);
  testParityStorage(["storage", "rm", "--yes", ...LOCAL_FLAGS, `ss:///${BUCKET}/rm-target.txt`], {
    failureType: "NON_AUTH",
  });
});
