import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IdleMonitor } from "./IdleMonitor.ts";

describe("IdleMonitor", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("fires onIdle after idleMs with no connections and no activity", () => {
    const idled: string[] = [];
    const mon = new IdleMonitor({ idleMs: 1000, onIdle: (id) => idled.push(id) });
    mon.track("a");
    mon.recordActivity("a", 0);
    vi.advanceTimersByTime(999);
    expect(idled).toEqual([]);
    vi.advanceTimersByTime(2);
    expect(idled).toEqual(["a"]);
  });

  it("open connections hold the pod warm indefinitely", () => {
    const idled: string[] = [];
    const mon = new IdleMonitor({ idleMs: 1000, onIdle: (id) => idled.push(id) });
    mon.track("a");
    mon.recordActivity("a", 1); // one open connection
    vi.advanceTimersByTime(10_000);
    expect(idled).toEqual([]);
    mon.recordActivity("a", 0); // last connection closed
    vi.advanceTimersByTime(1001);
    expect(idled).toEqual(["a"]);
  });

  it("activity resets the countdown; untrack cancels", () => {
    const idled: string[] = [];
    const mon = new IdleMonitor({ idleMs: 1000, onIdle: (id) => idled.push(id) });
    mon.track("a");
    mon.recordActivity("a", 0);
    vi.advanceTimersByTime(900);
    mon.recordActivity("a", 0); // reset
    vi.advanceTimersByTime(900);
    expect(idled).toEqual([]);
    mon.untrack("a");
    vi.advanceTimersByTime(5000);
    expect(idled).toEqual([]);
  });

  it("onIdle fires at most once per warm period and untracks the pod", () => {
    const idled: string[] = [];
    const mon = new IdleMonitor({ idleMs: 1000, onIdle: (id) => idled.push(id) });
    mon.track("a");
    mon.recordActivity("a", 0);
    vi.advanceTimersByTime(1000);
    expect(idled).toEqual(["a"]);
    // Timer already fired and pod was untracked; further advancing must not
    // fire onIdle again.
    vi.advanceTimersByTime(5000);
    expect(idled).toEqual(["a"]);
  });

  it("track on an already-tracked pod does not reset an existing countdown", () => {
    const idled: string[] = [];
    const mon = new IdleMonitor({ idleMs: 1000, onIdle: (id) => idled.push(id) });
    mon.track("a");
    mon.recordActivity("a", 0);
    vi.advanceTimersByTime(900);
    mon.track("a"); // already tracked: must be a no-op, not a reset
    vi.advanceTimersByTime(100);
    expect(idled).toEqual(["a"]);
  });

  it("re-arms after onIdle fires and the pod is tracked again", () => {
    const idled: string[] = [];
    const mon = new IdleMonitor({ idleMs: 1000, onIdle: (id) => idled.push(id) });
    mon.track("a");
    mon.recordActivity("a", 0);
    vi.advanceTimersByTime(1000);
    expect(idled).toEqual(["a"]);

    mon.track("a");
    mon.recordActivity("a", 0);
    vi.advanceTimersByTime(1000);
    expect(idled).toEqual(["a", "a"]);
  });
});
