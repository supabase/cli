import { describe, expect, it } from "@effect/vitest";
import {
  formatStopTimeoutMessage,
  looksLikeLeftoverPersistentData,
  makeProcessOutputTail,
  withLeftoverPersistentDataGuidance,
} from "./Diagnostics.ts";

describe("leftover persistent data guidance", () => {
  it("appends wipe guidance to initdb leftover errors", () => {
    const message = "initdb: directory exists but is not empty";
    expect(looksLikeLeftoverPersistentData(message)).toBe(true);
    const guided = withLeftoverPersistentDataGuidance(message);
    expect(guided).toBe(
      "initdb: directory exists but is not empty. Leftover files from a failed first start remain. stack destroy wipes them.",
    );
    expect(guided).not.toContain("db reset --local");
    expect(withLeftoverPersistentDataGuidance(guided)).toBe(guided);
  });

  it("leaves unrelated launch errors unchanged", () => {
    expect(withLeftoverPersistentDataGuidance("Native startup process exited with code 1")).toBe(
      "Native startup process exited with code 1",
    );
  });
});

describe("stop timeout message", () => {
  it("names still-running capabilities and that stop continues", () => {
    expect(formatStopTimeoutMessage(["database", "auth"])).toBe(
      "Stop timed out after 60s. Still running: database, auth. The owner stop continues in the background.",
    );
  });
});

describe("process output tail", () => {
  it("redacts known secrets from captured lines", () => {
    const tail = makeProcessOutputTail();
    tail.pushBytes("stderr", new TextEncoder().encode("password=s3cret\n"));
    expect(tail.finish(["s3cret"])).toBe("stderr: password=[REDACTED]");
  });
});
