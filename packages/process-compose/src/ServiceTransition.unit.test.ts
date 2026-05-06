import { describe, expect, it } from "vitest";
import { applyEvent } from "./ServiceTransition.ts";
import { ServiceState, initial } from "./ServiceState.ts";

const make = (
  name: string,
  overrides: Partial<{
    status: ServiceState["status"];
    pid: number | null;
    exitCode: number | null;
    restartCount: number;
    startedAt: number | null;
    error: string | null;
  }> = {},
): ServiceState =>
  new ServiceState({
    ...initial(name),
    ...overrides,
  });

describe("ServiceTransition", () => {
  describe("valid transitions", () => {
    it("Pending + DependenciesSatisfied → Starting", () => {
      const state = make("db");
      const next = applyEvent(state, { _tag: "DependenciesSatisfied" });
      expect(next).not.toBeNull();
      expect(next!.status).toBe("Starting");
    });

    it("Pending + DependencyFailed → Failed with error", () => {
      const state = make("api");
      const next = applyEvent(state, {
        _tag: "DependencyFailed",
        error: "db exited with code 1",
      });
      expect(next).not.toBeNull();
      expect(next!.status).toBe("Failed");
      expect(next!.error).toBe("db exited with code 1");
    });

    it("Starting + ProcessSpawned → Running with pid and startedAt", () => {
      const state = make("db", { status: "Starting" });
      const next = applyEvent(state, {
        _tag: "ProcessSpawned",
        pid: 1234,
        startedAt: 1000,
      });
      expect(next).not.toBeNull();
      expect(next!.status).toBe("Running");
      expect(next!.pid).toBe(1234);
      expect(next!.startedAt).toBe(1000);
    });

    it("Running + HealthCheckPassed → Healthy", () => {
      const state = make("db", { status: "Running", pid: 1234 });
      const next = applyEvent(state, { _tag: "HealthCheckPassed" });
      expect(next).not.toBeNull();
      expect(next!.status).toBe("Healthy");
    });

    it("Running + ProcessExited(0) → Stopped", () => {
      const state = make("db", { status: "Running", pid: 1234 });
      const next = applyEvent(state, { _tag: "ProcessExited", exitCode: 0 });
      expect(next).not.toBeNull();
      expect(next!.status).toBe("Stopped");
      expect(next!.exitCode).toBe(0);
    });

    it("Running + ProcessExited(1) → Failed", () => {
      const state = make("db", { status: "Running", pid: 1234 });
      const next = applyEvent(state, { _tag: "ProcessExited", exitCode: 1 });
      expect(next).not.toBeNull();
      expect(next!.status).toBe("Failed");
      expect(next!.exitCode).toBe(1);
    });

    it("Running + StopRequested → Stopping", () => {
      const state = make("db", { status: "Running", pid: 1234 });
      const next = applyEvent(state, { _tag: "StopRequested" });
      expect(next).not.toBeNull();
      expect(next!.status).toBe("Stopping");
    });

    it("Healthy + HealthCheckFailed → Unhealthy", () => {
      const state = make("db", { status: "Healthy", pid: 1234 });
      const next = applyEvent(state, { _tag: "HealthCheckFailed" });
      expect(next).not.toBeNull();
      expect(next!.status).toBe("Unhealthy");
    });

    it("Healthy + HealthCheckPassed → Healthy (same structural value)", () => {
      const state = make("db", { status: "Healthy", pid: 1234 });
      const next = applyEvent(state, { _tag: "HealthCheckPassed" });
      expect(next).not.toBeNull();
      expect(next!.status).toBe("Healthy");
      // Structural equality — SubscriptionRef won't broadcast
      expect(next).toEqual(state);
    });

    it("Healthy + ProcessExited(0) → Stopped", () => {
      const state = make("db", { status: "Healthy", pid: 1234 });
      const next = applyEvent(state, { _tag: "ProcessExited", exitCode: 0 });
      expect(next).not.toBeNull();
      expect(next!.status).toBe("Stopped");
    });

    it("Healthy + ProcessExited(1) → Failed", () => {
      const state = make("db", { status: "Healthy", pid: 1234 });
      const next = applyEvent(state, { _tag: "ProcessExited", exitCode: 1 });
      expect(next).not.toBeNull();
      expect(next!.status).toBe("Failed");
    });

    it("Healthy + StopRequested → Stopping", () => {
      const state = make("db", { status: "Healthy", pid: 1234 });
      const next = applyEvent(state, { _tag: "StopRequested" });
      expect(next).not.toBeNull();
      expect(next!.status).toBe("Stopping");
    });

    it("Unhealthy + HealthCheckPassed → Healthy", () => {
      const state = make("db", { status: "Unhealthy", pid: 1234 });
      const next = applyEvent(state, { _tag: "HealthCheckPassed" });
      expect(next).not.toBeNull();
      expect(next!.status).toBe("Healthy");
    });

    it("Unhealthy + ProcessExited(0) → Stopped", () => {
      const state = make("db", { status: "Unhealthy", pid: 1234 });
      const next = applyEvent(state, { _tag: "ProcessExited", exitCode: 0 });
      expect(next).not.toBeNull();
      expect(next!.status).toBe("Stopped");
    });

    it("Unhealthy + ProcessExited(1) → Failed", () => {
      const state = make("db", { status: "Unhealthy", pid: 1234 });
      const next = applyEvent(state, { _tag: "ProcessExited", exitCode: 1 });
      expect(next).not.toBeNull();
      expect(next!.status).toBe("Failed");
    });

    it("Unhealthy + StopRequested → Stopping", () => {
      const state = make("db", { status: "Unhealthy", pid: 1234 });
      const next = applyEvent(state, { _tag: "StopRequested" });
      expect(next).not.toBeNull();
      expect(next!.status).toBe("Stopping");
    });

    it("Stopping + ProcessExited → Stopped (any exit code)", () => {
      const state = make("db", { status: "Stopping", pid: 1234 });
      const next = applyEvent(state, { _tag: "ProcessExited", exitCode: 137 });
      expect(next).not.toBeNull();
      expect(next!.status).toBe("Stopped");
      expect(next!.exitCode).toBe(137);
    });

    it("Stopping + ProcessExited(0) → Stopped", () => {
      const state = make("db", { status: "Stopping", pid: 1234 });
      const next = applyEvent(state, { _tag: "ProcessExited", exitCode: 0 });
      expect(next).not.toBeNull();
      expect(next!.status).toBe("Stopped");
    });

    it("Stopped + RestartTriggered → Restarting", () => {
      const state = make("db", { status: "Stopped", exitCode: 0 });
      const next = applyEvent(state, {
        _tag: "RestartTriggered",
        restartCount: 1,
      });
      expect(next).not.toBeNull();
      expect(next!.status).toBe("Restarting");
      expect(next!.restartCount).toBe(1);
    });

    it("Failed + RestartTriggered → Restarting", () => {
      const state = make("db", { status: "Failed", exitCode: 1 });
      const next = applyEvent(state, {
        _tag: "RestartTriggered",
        restartCount: 2,
      });
      expect(next).not.toBeNull();
      expect(next!.status).toBe("Restarting");
      expect(next!.restartCount).toBe(2);
    });

    it("Unhealthy + RestartTriggered → Restarting", () => {
      const state = make("db", { status: "Unhealthy", pid: 1234 });
      const next = applyEvent(state, {
        _tag: "RestartTriggered",
        restartCount: 1,
      });
      expect(next).not.toBeNull();
      expect(next!.status).toBe("Restarting");
      expect(next!.restartCount).toBe(1);
    });

    it("Pending + StopRequested → Stopped (no process to kill)", () => {
      const state = make("db");
      const next = applyEvent(state, { _tag: "StopRequested" });
      expect(next).not.toBeNull();
      expect(next!.status).toBe("Stopped");
    });

    it("Starting + StopRequested → Stopping", () => {
      const state = make("db", { status: "Starting" });
      const next = applyEvent(state, { _tag: "StopRequested" });
      expect(next).not.toBeNull();
      expect(next!.status).toBe("Stopping");
    });

    it("Restarting + StopRequested → Stopped (no process to kill)", () => {
      const state = make("db", { status: "Restarting", restartCount: 1 });
      const next = applyEvent(state, { _tag: "StopRequested" });
      expect(next).not.toBeNull();
      expect(next!.status).toBe("Stopped");
    });

    it("Restarting + BackoffElapsed → Starting", () => {
      const state = make("db", { status: "Restarting", restartCount: 1 });
      const next = applyEvent(state, { _tag: "BackoffElapsed" });
      expect(next).not.toBeNull();
      expect(next!.status).toBe("Starting");
      // pid/exitCode/startedAt/error should be reset for new cycle
      expect(next!.pid).toBeNull();
      expect(next!.exitCode).toBeNull();
      expect(next!.startedAt).toBeNull();
      expect(next!.error).toBeNull();
    });
  });

  describe("invalid transitions return null", () => {
    it("Pending + HealthCheckPassed → null", () => {
      const state = make("db");
      expect(applyEvent(state, { _tag: "HealthCheckPassed" })).toBeNull();
    });

    it("Pending + ProcessExited → null", () => {
      const state = make("db");
      expect(applyEvent(state, { _tag: "ProcessExited", exitCode: 0 })).toBeNull();
    });

    it("Starting + HealthCheckPassed → null", () => {
      const state = make("db", { status: "Starting" });
      expect(applyEvent(state, { _tag: "HealthCheckPassed" })).toBeNull();
    });

    it("Running + DependenciesSatisfied → null", () => {
      const state = make("db", { status: "Running", pid: 1234 });
      expect(applyEvent(state, { _tag: "DependenciesSatisfied" })).toBeNull();
    });

    it("Running + RestartTriggered → null", () => {
      const state = make("db", { status: "Running", pid: 1234 });
      expect(applyEvent(state, { _tag: "RestartTriggered", restartCount: 1 })).toBeNull();
    });

    it("Stopped + ProcessExited → null", () => {
      const state = make("db", { status: "Stopped", exitCode: 0 });
      expect(applyEvent(state, { _tag: "ProcessExited", exitCode: 0 })).toBeNull();
    });

    it("Stopped + HealthCheckPassed → null", () => {
      const state = make("db", { status: "Stopped", exitCode: 0 });
      expect(applyEvent(state, { _tag: "HealthCheckPassed" })).toBeNull();
    });

    it("Failed + DependenciesSatisfied → null", () => {
      const state = make("db", { status: "Failed", exitCode: 1 });
      expect(applyEvent(state, { _tag: "DependenciesSatisfied" })).toBeNull();
    });

    it("Stopping + HealthCheckPassed → null (health probe races shutdown)", () => {
      const state = make("db", { status: "Stopping", pid: 1234 });
      expect(applyEvent(state, { _tag: "HealthCheckPassed" })).toBeNull();
    });

    it("Stopping + HealthCheckFailed → null", () => {
      const state = make("db", { status: "Stopping", pid: 1234 });
      expect(applyEvent(state, { _tag: "HealthCheckFailed" })).toBeNull();
    });

    it("Stopping + StopRequested → null (already stopping)", () => {
      const state = make("db", { status: "Stopping", pid: 1234 });
      expect(applyEvent(state, { _tag: "StopRequested" })).toBeNull();
    });

    it("Restarting + ProcessExited → null", () => {
      const state = make("db", { status: "Restarting", restartCount: 1 });
      expect(applyEvent(state, { _tag: "ProcessExited", exitCode: 0 })).toBeNull();
    });
  });

  describe("HookFailed event", () => {
    it("Running + HookFailed → Failed with error", () => {
      const state = make("db", { status: "Running", pid: 1234, startedAt: 1000 });
      const next = applyEvent(state, { _tag: "HookFailed", error: "migration failed" });
      expect(next).not.toBeNull();
      expect(next!.status).toBe("Failed");
      expect(next!.error).toBe("migration failed");
    });

    it("Healthy + HookFailed → Failed with error", () => {
      const state = make("db", { status: "Healthy", pid: 1234, startedAt: 1000 });
      const next = applyEvent(state, { _tag: "HookFailed", error: "seed failed" });
      expect(next).not.toBeNull();
      expect(next!.status).toBe("Failed");
      expect(next!.error).toBe("seed failed");
    });

    it("Pending + HookFailed → null (ignored)", () => {
      const state = make("db");
      expect(applyEvent(state, { _tag: "HookFailed", error: "x" })).toBeNull();
    });
  });

  describe("field preservation", () => {
    it("preserves name across transitions", () => {
      const state = make("postgres");
      const next = applyEvent(state, { _tag: "DependenciesSatisfied" });
      expect(next!.name).toBe("postgres");
    });

    it("preserves restartCount through non-restart transitions", () => {
      const state = make("db", {
        status: "Starting",
        restartCount: 3,
      });
      const next = applyEvent(state, {
        _tag: "ProcessSpawned",
        pid: 5678,
        startedAt: 2000,
      });
      expect(next!.restartCount).toBe(3);
    });

    it("preserves pid through health transitions", () => {
      const state = make("db", { status: "Running", pid: 1234 });
      const healthy = applyEvent(state, { _tag: "HealthCheckPassed" });
      expect(healthy!.pid).toBe(1234);
      const unhealthy = applyEvent(healthy!, { _tag: "HealthCheckFailed" });
      expect(unhealthy!.pid).toBe(1234);
    });
  });
});
