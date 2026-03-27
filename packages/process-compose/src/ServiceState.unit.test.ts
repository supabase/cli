import { describe, expect, it } from "vitest";
import { ServiceState, initial } from "./ServiceState.ts";

describe("ServiceState", () => {
  it("creates initial state with Pending status", () => {
    const state = initial("postgres");
    expect(state.name).toBe("postgres");
    expect(state.status).toBe("Pending");
    expect(state.pid).toBeNull();
    expect(state.exitCode).toBeNull();
    expect(state.restartCount).toBe(0);
    expect(state.startedAt).toBeNull();
    expect(state.error).toBeNull();
  });

  it("supports structural equality", () => {
    const a = initial("postgres");
    const b = initial("postgres");
    expect(a).toEqual(b);
  });

  it("can transition via Data.Class copy", () => {
    const state = initial("postgres");
    const running = new ServiceState({
      ...state,
      status: "Running",
      pid: 1234,
      startedAt: Date.now(),
    });
    expect(running.status).toBe("Running");
    expect(running.pid).toBe(1234);
    expect(running.name).toBe("postgres");
  });
});
