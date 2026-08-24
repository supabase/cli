import { describe, expect, it, vi } from "vitest";
import { Effect, Fiber } from "effect";
import { terminateChildProcess } from "./terminateChild.ts";

interface ChildLike {
  readonly pid?: number;
  kill: (signal?: NodeJS.Signals) => void;
  once: (event: "exit", listener: () => void) => void;
  off: (event: "exit", listener: () => void) => void;
}

class FakeChild implements ChildLike {
  readonly pid = 1234;
  exitCode: number | null = null;
  readonly signals: Array<NodeJS.Signals> = [];
  #listeners = new Set<() => void>();

  get listenerCount(): number {
    return this.#listeners.size;
  }

  constructor(
    private readonly onKill: (signal: NodeJS.Signals, child: FakeChild) => void = () => {},
  ) {}

  kill(signal: NodeJS.Signals = "SIGTERM"): void {
    this.signals.push(signal);
    this.onKill(signal, this);
  }

  once(_event: "exit", listener: () => void): void {
    this.#listeners.add(listener);
  }

  off(_event: "exit", listener: () => void): void {
    this.#listeners.delete(listener);
  }

  exit(): void {
    for (const listener of this.#listeners) {
      listener();
    }
    this.#listeners.clear();
  }
}

describe("terminateChildProcess", () => {
  it("sends SIGTERM and stops when the child exits in time", async () => {
    const child = new FakeChild((signal, self) => {
      if (signal === "SIGTERM") {
        self.exit();
      }
    });

    await Effect.runPromise(terminateChildProcess(child, { timeoutMs: 100 }));

    expect(child.signals).toEqual(["SIGTERM"]);
  });

  it("escalates to SIGKILL when the child ignores SIGTERM", async () => {
    const child = new FakeChild((signal, self) => {
      if (signal === "SIGKILL") {
        self.exit();
      }
    });

    await Effect.runPromise(terminateChildProcess(child, { timeoutMs: 10 }));

    expect(child.signals).toEqual(["SIGTERM", "SIGKILL"]);
  });
});

describe("terminateChildProcess on an already-exited child", () => {
  it("returns immediately instead of waiting out both signal timeouts", async () => {
    // A dead ChildProcess never fires another `exit` event, so before this
    // guard the call burned 2x timeoutMs listening for one — which turned a
    // teardown sweep over dead children into the very afterAll hook timeout
    // the sweep exists to prevent.
    const child = new FakeChild();
    child.exitCode = 0;
    await Effect.runPromise(terminateChildProcess(child, { timeoutMs: 5_000 }));
    expect(child.signals).toEqual([]);
  });

  it("skips the SIGKILL wait when the child dies between checks", async () => {
    const child = new FakeChild((signal, self) => {
      if (signal === "SIGTERM") {
        self.exitCode = 143;
      }
    });
    vi.useFakeTimers();
    try {
      const termination = Effect.runPromise(terminateChildProcess(child, { timeoutMs: 300 }));
      await vi.runAllTimersAsync();
      await termination;
      expect(child.signals).toEqual(["SIGTERM"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("removes the exit listener when termination is interrupted", async () => {
    const child = new FakeChild();
    const fiber = Effect.runFork(terminateChildProcess(child, { timeoutMs: 1_000 }));
    await Effect.runPromise(Effect.yieldNow);

    expect(child.listenerCount).toBe(1);
    await Effect.runPromise(Fiber.interrupt(fiber));
    expect(child.listenerCount).toBe(0);
  });
});
