import type { Orchestrator } from "../core/orchestrator.ts";

export interface ApiServer {
  start(): void;
  stop(): void;
  readonly port: number;
  readonly url: string;
}

export function createApiServer(orchestrator: Orchestrator, port: number = 8080): ApiServer {
  let server: ReturnType<typeof Bun.serve> | null = null;

  function start(): void {
    if (server) return;

    server = Bun.serve({
      port,
      fetch: async (req) => {
        const url = new URL(req.url);
        const path = url.pathname;
        const method = req.method;

        try {
          // Health check
          if (method === "GET" && path === "/live") {
            return json({ status: "alive" });
          }

          // Get all processes
          if (method === "GET" && path === "/processes") {
            return json(orchestrator.getProcessesState());
          }

          // Get project name
          if (method === "GET" && path === "/project/name") {
            return json({ projectName: orchestrator.projectName });
          }

          // Stop project
          if (method === "POST" && path === "/project/stop") {
            // Respond first, then stop
            setTimeout(() => orchestrator.stop(), 100);
            return json({ status: "stopping" });
          }

          // Get single process
          const processMatch = path.match(/^\/process\/([^/]+)$/);
          if (method === "GET" && processMatch) {
            const name = decodeURIComponent(processMatch[1]!);
            const state = orchestrator.getProcessState(name);
            if (!state) {
              return json({ error: `Process "${name}" not found` }, 404);
            }
            return json(state);
          }

          // Start process
          const startMatch = path.match(/^\/process\/start\/([^/]+)$/);
          if (method === "POST" && startMatch) {
            const name = decodeURIComponent(startMatch[1]!);
            try {
              await orchestrator.startProcess(name);
              return json({ name });
            } catch (err) {
              return json({ error: String(err) }, 400);
            }
          }

          // Stop process
          const stopMatch = path.match(/^\/process\/stop\/([^/]+)$/);
          if (method === "PATCH" && stopMatch) {
            const name = decodeURIComponent(stopMatch[1]!);
            try {
              await orchestrator.stopProcess(name);
              return json({ name });
            } catch (err) {
              return json({ error: String(err) }, 400);
            }
          }

          // Restart process
          const restartMatch = path.match(/^\/process\/restart\/([^/]+)$/);
          if (method === "POST" && restartMatch) {
            const name = decodeURIComponent(restartMatch[1]!);
            try {
              await orchestrator.restartProcess(name);
              return json({ name });
            } catch (err) {
              return json({ error: String(err) }, 400);
            }
          }

          // Get process logs
          const logsMatch = path.match(/^\/process\/logs\/([^/]+)\/(\d+)\/(\d+)$/);
          if (method === "GET" && logsMatch) {
            const name = decodeURIComponent(logsMatch[1]!);
            const offset = parseInt(logsMatch[2]!, 10);
            const limit = parseInt(logsMatch[3]!, 10);
            const logs = orchestrator.getProcessLogs(name, offset, limit);
            return json({ logs });
          }

          // Truncate process logs
          const truncateMatch = path.match(/^\/process\/logs\/([^/]+)$/);
          if (method === "DELETE" && truncateMatch) {
            const name = decodeURIComponent(truncateMatch[1]!);
            orchestrator.truncateProcessLogs(name);
            return json({ name });
          }

          // 404 for unknown routes
          return json({ error: "Not found" }, 404);
        } catch (err) {
          console.error("API error:", err);
          return json({ error: "Internal server error" }, 500);
        }
      },
    });

    console.log(`Process Compose API server listening on http://localhost:${server.port}`);
  }

  function stop(): void {
    if (server) {
      void server.stop();
      server = null;
    }
  }

  return {
    start,
    stop,
    get port() {
      return server?.port ?? port;
    },
    get url() {
      return `http://localhost:${server?.port ?? port}`;
    },
  };
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
    },
  });
}
