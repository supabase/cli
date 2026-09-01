import { describe, expect, it } from "vitest";
import { makeAnalyticsServicesNative } from "./analytics.ts";

describe("makeAnalyticsServicesNative", () => {
  it("runs migration before a loopback server with the frozen runtime profile", () => {
    const dependencies = [{ service: "postgres-init", condition: "completed" }] as const;
    const bundle = makeAnalyticsServicesNative({
      binPath: "/cache/analytics/v1.50.3/darwin-arm64",
      runtimeRoot: "/tmp/stacks/project-a/runtime",
      hostPort: 54327,
      dbPort: 54322,
      apiKey: "analytics-key",
      backend: "postgres",
      dependencies,
    });

    expect(bundle.migrate).toMatchObject({
      name: "analytics-migrate",
      command: "/cache/analytics/v1.50.3/darwin-arm64/bin/logflare",
      args: ["eval", "Logflare.Release.migrate"],
      restart: "no",
      dependencies,
    });
    expect(bundle.seed).toMatchObject({
      name: "analytics-seed",
      command: "/cache/analytics/v1.50.3/darwin-arm64/bin/logflare",
      args: [
        "eval",
        `{:ok, _} = Application.ensure_all_started(:logflare)
startup_task =
  Supervisor.which_children(Logflare.Supervisor)
  |> Enum.find(fn
    {Task, pid, :worker, _modules} when is_pid(pid) -> true
    _ -> false
  end)

case startup_task do
  {Task, pid, :worker, _modules} ->
    ref = Process.monitor(pid)

    receive do
      {:DOWN, ^ref, :process, ^pid, :normal} -> :ok
      {:DOWN, ^ref, :process, ^pid, reason} ->
        raise "Logflare startup task failed: #{inspect(reason)}"
    after
      120_000 ->
        Process.demonitor(ref, [:flush])
        raise "Timed out waiting for Logflare startup task"
    end

  nil ->
    :ok
end

status = Logflare.SingleTenant.supabase_mode_status()

if status |> Map.values() |> Enum.all?(&(&1 == :ok)) do
  :ok
else
  raise "Logflare single-tenant bootstrap incomplete: #{inspect(status)}"
end`,
      ],
      restart: "no",
      dependencies: [{ service: "analytics-migrate", condition: "completed" }],
    });
    expect(bundle.seed.env).toMatchObject({
      PORT: "0",
      PHX_HTTP_PORT: "0",
      PHX_HTTP_IP: "127.0.0.1",
      LOGFLARE_SINGLE_TENANT: "true",
      LOGFLARE_SUPABASE_MODE: "true",
      LOGFLARE_PUBLIC_ACCESS_TOKEN: "analytics-key-public",
      LOGFLARE_PRIVATE_ACCESS_TOKEN: "analytics-key",
    });
    expect(bundle.server).toMatchObject({
      name: "analytics",
      command: "/cache/analytics/v1.50.3/darwin-arm64/bin/logflare",
      args: ["start"],
      restart: "unless-stopped",
      dependencies: [{ service: "analytics-seed", condition: "completed" }],
    });
    expect(bundle.server.env).toMatchObject({
      PORT: "54327",
      PHX_HTTP_PORT: "54327",
      PHX_HTTP_IP: "127.0.0.1",
      DB_HOSTNAME: "127.0.0.1",
      LOGFLARE_NODE_HOST: "127.0.0.1",
      DB_POOL_SIZE: "2",
      LOGFLARE_PUBSUB_POOL_SIZE: "2",
      ELIXIR_ERL_OPTIONS: "+S 1:1 +SDio 1 +sbwt none +sbwtdcpu none +sbwtdio none",
      RELEASE_DISTRIBUTION: "none",
      ERL_CRASH_DUMP: "/tmp/stacks/project-a/runtime/analytics/erl_crash.dump",
      LOGFLARE_PUBLIC_ACCESS_TOKEN: "analytics-key-public",
      LOGFLARE_PRIVATE_ACCESS_TOKEN: "analytics-key",
    });
    expect(bundle.server.env).not.toHaveProperty("ERL_AFLAGS");
    expect(bundle.server.env).not.toHaveProperty("ERL_EPMD_ADDRESS");
    expect(bundle.server.env).not.toHaveProperty("RELEASE_COOKIE");
    expect(bundle.server.healthCheck?.probe).toEqual({
      _tag: "Http",
      host: "127.0.0.1",
      port: 54327,
      path: "/health",
      scheme: "http",
    });
  });
});
