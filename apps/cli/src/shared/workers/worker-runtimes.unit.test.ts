import { describe, expect, test } from "vitest";
import {
  apiSizeFor,
  formatApiSize,
  parseWorkerExposure,
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
    expect(parseWorkerRuntime("sandbox")).toBeUndefined();
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
    expect(formatApiSize("2gb-1vcpu")).toBe("2gb (1 vCPU)");
    expect(formatApiSize("16gb-8vcpu")).toBe("16gb (8 vCPU)");
    expect(formatApiSize("something-else")).toBe("something-else");
  });

  test("parse case-insensitively, and reject anything outside the catalog", () => {
    expect(parseWorkerSize("4GB")).toBe("4gb");
    expect(parseWorkerSize("  2gb ")).toBe("2gb");
    expect(parseWorkerSize("64gb")).toBeUndefined();
    expect(parseWorkerSize("")).toBeUndefined();
  });
});

describe("parseWorkerExposure", () => {
  test("accepts both exposures case-insensitively, and canonicalizes them", () => {
    expect(parseWorkerExposure("Public")).toBe("public");
    expect(parseWorkerExposure("  PRIVATE ")).toBe("private");
  });

  // A typo here would otherwise read as the default and put a worker somebody
  // meant to keep private on the internet, so nothing near-miss is accepted.
  test("rejects anything outside the pair, including near misses", () => {
    expect(parseWorkerExposure("privat")).toBeUndefined();
    expect(parseWorkerExposure("internal")).toBeUndefined();
    expect(parseWorkerExposure("")).toBeUndefined();
  });
});

describe("validateWorkerNameMessage", () => {
  test("accepts DNS labels", () => {
    expect(validateWorkerNameMessage("api")).toBeUndefined();
    expect(validateWorkerNameMessage("my-worker-1")).toBeUndefined();
    expect(validateWorkerNameMessage("a")).toBeUndefined();
  });

  test.each(["My-Worker", "-leading", "trailing-", "under_score", "", "a".repeat(64)])(
    "rejects %j",
    (name) => {
      expect(validateWorkerNameMessage(name)).toBeDefined();
    },
  );
});
