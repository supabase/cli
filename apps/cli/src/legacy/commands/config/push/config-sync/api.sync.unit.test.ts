import { describe, expect, it } from "vitest";

import {
  apiToUpdateBody,
  diffApiWithRemote,
  type ApiSubset,
  type RemoteApiConfig,
} from "./api.sync.ts";

/**
 * Golden parity with Go `pkg/config/api_test.go` (`TestApiDiff`,
 * `TestApiToUpdatePostgrestConfigBody`). The expected diffs are the exact bytes
 * of `pkg/config/testdata/TestApiDiff/*.diff`. The Go unit test builds bare
 * structs (port = 0, tls zero, external_url = ""), reproduced here.
 */

function bareApi(overrides: Partial<ApiSubset>): ApiSubset {
  return {
    enabled: false,
    schemas: undefined,
    extra_search_path: undefined,
    max_rows: 0,
    auto_expose_new_tables: undefined,
    port: 0,
    tls: { enabled: false, cert_path: "", key_path: "" },
    external_url: "",
    ...overrides,
  };
}

const lines = (...l: Array<string>) => l.join("\n") + "\n";

describe("diffApiWithRemote", () => {
  it("detects differences", () => {
    const local = bareApi({
      enabled: true,
      schemas: ["public", "private"],
      extra_search_path: ["extensions", "public"],
      max_rows: 1000,
    });
    const remote: RemoteApiConfig = {
      db_schema: "public",
      db_extra_search_path: "public",
      max_rows: 500,
    };
    expect(diffApiWithRemote(local, remote)).toBe(
      lines(
        "diff remote[api] local[api]",
        "--- remote[api]",
        "+++ local[api]",
        "@@ -1,7 +1,7 @@",
        " enabled = true",
        '-schemas = ["public"]',
        '-extra_search_path = ["public"]',
        "-max_rows = 500",
        '+schemas = ["public", "private"]',
        '+extra_search_path = ["extensions", "public"]',
        "+max_rows = 1000",
        " port = 0",
        ' external_url = ""',
        " ",
      ),
    );
  });

  it("handles no differences", () => {
    const local = bareApi({
      enabled: true,
      schemas: ["public"],
      extra_search_path: ["public"],
      max_rows: 500,
    });
    const remote: RemoteApiConfig = {
      db_schema: "public",
      db_extra_search_path: "public",
      max_rows: 500,
    };
    expect(diffApiWithRemote(local, remote)).toBe("");
  });

  it("handles multiple schemas and search paths with spaces", () => {
    const local = bareApi({
      enabled: true,
      schemas: ["public", "private"],
      extra_search_path: ["extensions", "public"],
      max_rows: 500,
    });
    const remote: RemoteApiConfig = {
      db_schema: "public, private",
      db_extra_search_path: "extensions, public",
      max_rows: 500,
    };
    expect(diffApiWithRemote(local, remote)).toBe("");
  });

  it("handles api disabled on remote side", () => {
    const local = bareApi({
      enabled: true,
      schemas: ["public", "private"],
      extra_search_path: ["extensions", "public"],
      max_rows: 500,
    });
    const remote: RemoteApiConfig = { db_schema: "", db_extra_search_path: "", max_rows: 0 };
    expect(diffApiWithRemote(local, remote)).toBe(
      lines(
        "diff remote[api] local[api]",
        "--- remote[api]",
        "+++ local[api]",
        "@@ -1,4 +1,4 @@",
        "-enabled = false",
        "+enabled = true",
        ' schemas = ["public", "private"]',
        ' extra_search_path = ["extensions", "public"]',
        " max_rows = 500",
      ),
    );
  });

  it("handles api disabled on local side", () => {
    const local = bareApi({
      enabled: false,
      schemas: ["public"],
      extra_search_path: ["public"],
      max_rows: 500,
    });
    const remote: RemoteApiConfig = {
      db_schema: "public",
      db_extra_search_path: "public",
      max_rows: 500,
    };
    expect(diffApiWithRemote(local, remote)).toBe(
      lines(
        "diff remote[api] local[api]",
        "--- remote[api]",
        "+++ local[api]",
        "@@ -1,4 +1,4 @@",
        "-enabled = true",
        "+enabled = false",
        ' schemas = ["public"]',
        ' extra_search_path = ["public"]',
        " max_rows = 500",
      ),
    );
  });
});

describe("apiToUpdateBody", () => {
  it("converts all fields correctly", () => {
    const body = apiToUpdateBody(
      bareApi({
        enabled: true,
        schemas: ["public", "private"],
        extra_search_path: ["extensions", "public"],
        max_rows: 1000,
      }),
    );
    expect(body.db_schema).toBe("public,private");
    expect(body.db_extra_search_path).toBe("extensions,public");
    expect(body.max_rows).toBe(1000);
  });

  it("handles empty fields (disabled api → empty schema)", () => {
    const body = apiToUpdateBody(bareApi({ enabled: false }));
    expect(body.db_schema).toBe("");
  });
});
