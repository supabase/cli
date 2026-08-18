import { describe, expect, test } from "vitest";
import {
  apiSizeFor,
  exposureFor,
  formatApiSize,
  parseWorkerRuntime,
  parseWorkerSize,
  validateWorkerNameMessage,
  vcpuForSize,
} from "./worker-runtimes.ts";

describe("parseWorkerRuntime", () => {
  test("accepts the value it displays, case-insensitively, and canonicalizes it", () => {
    expect(parseWorkerRuntime("Dockerfile")).toBe("dockerfile");
    expect(parseWorkerRuntime("  NODE  ")).toBe("node");
  });

  test("rejects anything outside the catalog", () => {
    expect(parseWorkerRuntime("rust")).toBeUndefined();
    expect(parseWorkerRuntime("")).toBeUndefined();
  });
});

describe("sizes", () => {
  test("each size implies its own vCPU count", () => {
    expect(vcpuForSize("2gb")).toBe(1);
    expect(vcpuForSize("4gb")).toBe(2);
  });

  test("map onto the spelling the Workers API takes", () => {
    expect(apiSizeFor("2gb")).toBe("2gb-1vcpu");
    expect(apiSizeFor("4gb")).toBe("4gb-2vcpu");
  });

  test("render back for display, and pass through anything unrecognized verbatim", () => {
    expect(formatApiSize("2gb-1vcpu")).toBe("2gb · 1 vCPU");
    expect(formatApiSize("16gb-8vcpu")).toBe("16gb · 8 vCPU");
    expect(formatApiSize("something-else")).toBe("something-else");
  });

  test("parse case-insensitively and reject sizes outside the alpha envelope", () => {
    expect(parseWorkerSize("4GB")).toBe("4gb");
    expect(parseWorkerSize("8gb")).toBeUndefined();
  });
});

describe("exposureFor", () => {
  test("is public for everything that serves HTTP and private for a bare sandbox", () => {
    expect(exposureFor("node")).toBe("public");
    expect(exposureFor("dockerfile")).toBe("public");
    expect(exposureFor("sandbox")).toBe("private");
  });
});

describe("validateWorkerNameMessage", () => {
  test("accepts DNS labels", () => {
    expect(validateWorkerNameMessage("api")).toBeUndefined();
    expect(validateWorkerNameMessage("my-worker-1")).toBeUndefined();
    expect(validateWorkerNameMessage("a")).toBeUndefined();
  });

  test("refuses `root`, which collides with the [workers] table's own key", () => {
    expect(validateWorkerNameMessage("root")).toContain("reserved");
  });

  test.each(["My-Worker", "-leading", "trailing-", "under_score", "", "a".repeat(64)])(
    "rejects %j",
    (name) => {
      expect(validateWorkerNameMessage(name)).toBeDefined();
    },
  );
});
