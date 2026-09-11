import { describe, expect, test } from "vitest";
import {
  apiRuntimeFor,
  apiSizeFor,
  defaultExposureFor,
  deployedRuntimeLabel,
  formatApiSize,
  parseComputeExposure,
  parseComputeRuntime,
  parseComputeSize,
  validateComputeNameMessage,
  vcpuForSize,
} from "./compute-runtimes.ts";

describe("parseComputeRuntime", () => {
  test("accepts the value it displays, case-insensitively, and canonicalizes it", () => {
    expect(parseComputeRuntime("Dockerfile")).toBe("dockerfile");
    expect(parseComputeRuntime("  NODE  ")).toBe("node");
    expect(parseComputeRuntime("Actions-Runner")).toBe("actions-runner");
  });

  test("rejects anything outside the catalog", () => {
    expect(parseComputeRuntime("rust")).toBeUndefined();
    expect(parseComputeRuntime("sandbox")).toBeUndefined();
    expect(parseComputeRuntime("")).toBeUndefined();
  });
});

describe("apiRuntimeFor", () => {
  test("names the catalog base image a runtime builds on", () => {
    expect(apiRuntimeFor("node")).toBe("node");
    expect(apiRuntimeFor("deno")).toBe("deno");
  });

  // The API knows only its catalog images: a runtime whose starter ships a
  // Dockerfile is deployed as the image that Dockerfile describes.
  test("sends no runtime for a runtime built from the context's own Dockerfile", () => {
    expect(apiRuntimeFor("dockerfile")).toBeUndefined();
    expect(apiRuntimeFor("actions-runner")).toBeUndefined();
  });
});

describe("deployedRuntimeLabel", () => {
  test("reports what the deployed spec says whenever it says anything", () => {
    expect(deployedRuntimeLabel({ apiRuntime: "node", declared: "deno" })).toBe("node");
  });

  test("names the context-built runtime config declared when the spec omits one", () => {
    expect(deployedRuntimeLabel({ apiRuntime: undefined, declared: "actions-runner" })).toBe(
      "actions-runner",
    );
    expect(deployedRuntimeLabel({ apiRuntime: undefined, declared: "dockerfile" })).toBe(
      "dockerfile",
    );
  });

  // Absent `spec.runtime` is itself the evidence of a context build, so a
  // declaration that contradicts it describes something that isn't deployed.
  test("falls back to dockerfile when the declaration cannot explain the omission", () => {
    expect(deployedRuntimeLabel({ apiRuntime: undefined, declared: "node" })).toBe("dockerfile");
    expect(deployedRuntimeLabel({ apiRuntime: undefined, declared: "cobol" })).toBe("dockerfile");
    expect(deployedRuntimeLabel({ apiRuntime: undefined, declared: undefined })).toBe("dockerfile");
  });
});

describe("defaultExposureFor", () => {
  test("keeps a runner off the internet and leaves every other runtime public", () => {
    expect(defaultExposureFor("actions-runner")).toBe("private");
    expect(defaultExposureFor("node")).toBe("public");
    expect(defaultExposureFor("dockerfile")).toBe("public");
  });
});

describe("sizes", () => {
  test("each size implies its own vCPU count", () => {
    expect(vcpuForSize("2gb")).toBe(1);
    expect(vcpuForSize("4gb")).toBe(2);
  });

  test("map onto the spelling the Compute API takes", () => {
    expect(apiSizeFor("2gb")).toBe("2gb-1vcpu");
    expect(apiSizeFor("4gb")).toBe("4gb-2vcpu");
  });

  test("render back for display, and pass through anything unrecognized verbatim", () => {
    expect(formatApiSize("2gb-1vcpu")).toBe("2gb (1 vCPU)");
    expect(formatApiSize("16gb-8vcpu")).toBe("16gb (8 vCPU)");
    expect(formatApiSize("something-else")).toBe("something-else");
  });

  test("parse case-insensitively, and reject anything outside the catalog", () => {
    expect(parseComputeSize("4GB")).toBe("4gb");
    expect(parseComputeSize("  2gb ")).toBe("2gb");
    expect(parseComputeSize("64gb")).toBeUndefined();
    expect(parseComputeSize("")).toBeUndefined();
  });
});

describe("parseComputeExposure", () => {
  test("accepts both exposures case-insensitively, and canonicalizes them", () => {
    expect(parseComputeExposure("Public")).toBe("public");
    expect(parseComputeExposure("  PRIVATE ")).toBe("private");
  });

  // A typo here would otherwise read as the default and put a compute somebody
  // meant to keep private on the internet, so nothing near-miss is accepted.
  test("rejects anything outside the pair, including near misses", () => {
    expect(parseComputeExposure("privat")).toBeUndefined();
    expect(parseComputeExposure("internal")).toBeUndefined();
    expect(parseComputeExposure("")).toBeUndefined();
  });
});

describe("validateComputeNameMessage", () => {
  test("accepts DNS labels", () => {
    expect(validateComputeNameMessage("api")).toBeUndefined();
    expect(validateComputeNameMessage("my-compute-1")).toBeUndefined();
    expect(validateComputeNameMessage("a")).toBeUndefined();
  });

  test.each(["My-Compute", "-leading", "trailing-", "under_score", "", "a".repeat(64)])(
    "rejects %j",
    (name) => {
      expect(validateComputeNameMessage(name)).toBeDefined();
    },
  );
});
