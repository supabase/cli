import { describe, expect, it } from "vitest";
import { terminateChildProcess } from "./terminateChild.ts";

interface ChildLike {
  readonly pid?: number;
  kill: (signal?: NodeJS.Signals) => void;
  once: (event: "exit", listener: () => void) => void;
  off: (event: "exit", listener: () => void) => void;
}

class FakeChild implements ChildLike {
  readonly pid = 1234;
  readonly signals: Array<NodeJS.Signals> = [];
  #listeners = new Set<() => void>();

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
        setTimeout(() => self.exit(), 0);
      }
    });

    await terminateChildProcess(child, { timeoutMs: 100 });

    expect(child.signals).toEqual(["SIGTERM"]);
  });

  it("escalates to SIGKILL when the child ignores SIGTERM", async () => {
    const child = new FakeChild((signal, self) => {
      if (signal === "SIGKILL") {
        setTimeout(() => self.exit(), 0);
      }
    });

    await terminateChildProcess(child, { timeoutMs: 10 });

    expect(child.signals).toEqual(["SIGTERM", "SIGKILL"]);
  });
});
