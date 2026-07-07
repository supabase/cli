interface Tracked {
  timer: ReturnType<typeof setTimeout> | undefined;
  openConnections: number;
}

/**
 * Connection-aware idle countdown: fires `onIdle(podId)` once a tracked pod
 * has no open connections and no activity for `idleMs`.
 *
 * Design assumptions:
 * - **Open connections hold the pod warm indefinitely.** While
 *   `openConnections > 0` (as last reported via `recordActivity`) the
 *   countdown never starts, no matter how much time passes.
 * - **The countdown restarts on the last connection closing or on any
 *   activity.** Both are reported via `recordActivity`; each call re-arms
 *   the timer from `idleMs`.
 * - **`onIdle` fires at most once per warm period.** When the timer fires,
 *   the pod is untracked before `onIdle` runs; a subsequent `track()` is
 *   required to re-arm it.
 * - **`track()` on an already-tracked pod is a no-op.** It does not reset
 *   an in-flight countdown; callers that want a reset should use
 *   `recordActivity` instead.
 */
export class IdleMonitor {
  private readonly tracked = new Map<string, Tracked>();

  constructor(
    private readonly opts: {
      readonly idleMs: number;
      readonly onIdle: (podId: string) => void;
    },
  ) {}

  /** Start tracking a pod (e.g. on wake). No-op if already tracked. */
  track(podId: string): void {
    if (!this.tracked.has(podId)) {
      this.tracked.set(podId, { timer: undefined, openConnections: 0 });
      this.arm(podId);
    }
  }

  /** Stop tracking (on suspend/destroy). */
  untrack(podId: string): void {
    const entry = this.tracked.get(podId);
    if (entry?.timer) clearTimeout(entry.timer);
    this.tracked.delete(podId);
  }

  /** Wire to EdgeProxy events: any activity resets the timer; open connections hold it. */
  recordActivity(podId: string, openConnections: number): void {
    const entry = this.tracked.get(podId);
    if (!entry) return;
    entry.openConnections = openConnections;
    this.arm(podId);
  }

  private arm(podId: string): void {
    const entry = this.tracked.get(podId);
    if (!entry) return;
    if (entry.timer) clearTimeout(entry.timer);
    entry.timer = undefined;
    if (entry.openConnections > 0) return; // held warm by open connections
    entry.timer = setTimeout(() => {
      this.tracked.delete(podId);
      this.opts.onIdle(podId);
    }, this.opts.idleMs);
    entry.timer.unref?.();
  }
}
