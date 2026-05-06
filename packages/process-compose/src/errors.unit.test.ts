import { describe, expect, it } from "vitest";
import {
  CyclicDependencyError,
  MissingDependencyError,
  ServiceNotFoundError,
  SpawnError,
  ShutdownTimeoutError,
} from "./errors.ts";

describe("errors", () => {
  it("CyclicDependencyError has correct tag and data", () => {
    const err = new CyclicDependencyError({ cycle: "a -> b -> a" });
    expect(err._tag).toBe("CyclicDependencyError");
    expect(err.cycle).toBe("a -> b -> a");
  });

  it("MissingDependencyError has correct tag and data", () => {
    const err = new MissingDependencyError({ service: "app", dependency: "db" });
    expect(err._tag).toBe("MissingDependencyError");
    expect(err.service).toBe("app");
    expect(err.dependency).toBe("db");
  });

  it("ServiceNotFoundError has correct tag and data", () => {
    const err = new ServiceNotFoundError({ name: "unknown" });
    expect(err._tag).toBe("ServiceNotFoundError");
    expect(err.name).toBe("unknown");
  });

  it("SpawnError has correct tag and data", () => {
    const cause = new Error("ENOENT");
    const err = new SpawnError({ service: "postgres", cause });
    expect(err._tag).toBe("SpawnError");
    expect(err.service).toBe("postgres");
    expect(err.cause).toBe(cause);
  });

  it("ShutdownTimeoutError has correct tag and data", () => {
    const err = new ShutdownTimeoutError({ service: "postgres" });
    expect(err._tag).toBe("ShutdownTimeoutError");
    expect(err.service).toBe("postgres");
  });
});
