import { describe, expect, it } from "vitest";
import { withChildTraceEnv } from "./spans.ts";

const traceEnv = { TRACEPARENT: "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01" };

describe("withChildTraceEnv", () => {
  it("leaves spawn options untouched without a trace environment", () => {
    const options = { cwd: "/tmp" };

    expect(withChildTraceEnv(options, {})).toBe(options);
  });

  it("inherits the parent environment when the caller sets none", () => {
    expect(withChildTraceEnv({ cwd: "/tmp" }, traceEnv)).toEqual({
      cwd: "/tmp",
      env: traceEnv,
      extendEnv: true,
    });
  });

  it("keeps an explicit request not to inherit the parent environment", () => {
    expect(withChildTraceEnv({ extendEnv: false }, traceEnv)).toEqual({
      env: traceEnv,
      extendEnv: false,
    });
  });

  it("adds the trace environment to a caller-provided environment", () => {
    expect(withChildTraceEnv({ env: { PGHOST: "localhost" }, extendEnv: false }, traceEnv)).toEqual(
      { env: { PGHOST: "localhost", ...traceEnv }, extendEnv: false },
    );
  });
});
