import { Data, Effect } from "effect";
import type { ChildProcessSpawner } from "effect/process";
import { DOCKER_HOST_ALIAS, runRaw, type EngineTarget } from "./Container.ts";

const platformName = (platform: NodeJS.Platform) =>
  platform === "darwin" ? "macos" : platform === "win32" ? "windows" : platform;

/** The runtime a failed start check names, like `macos rootless podman`. */
export const apiTlsRuntimeLabel = (
  target: EngineTarget,
  platform: NodeJS.Platform = process.platform,
) => {
  const rootless = target.engine === "podman" && target.rootless ? "rootless " : "";
  return `${platformName(platform)} ${rootless}${target.engine}`;
};

/** The stack the start check probes from, by its primary database instance. */
interface ApiTlsStack {
  readonly id: string;
  readonly root: string;
  readonly database: string | undefined;
}

class ApiTlsCheckError extends Data.TaggedError("ApiTlsCheckError")<{
  readonly message: string;
  /** What the probe saw: no database container, the engine's error, or the reply. */
  readonly detail: string;
  /** What to do once the stack's services stopped. */
  readonly next: string;
}> {}

/**
 * Classifies the probe's output, `<read status> <bytes read>`: only status 1 (the end of the reply)
 * with a 200 and exactly `body` passes; above 128 is a timeout, 0 a NUL byte.
 */
export const readApiTlsCheck = (
  output: string,
  body: string,
  readSeconds: number,
):
  | { readonly outcome: "passed" }
  | { readonly outcome: "closed" }
  | { readonly outcome: "foreign"; readonly detail: string } => {
  const space = output.indexOf(" ");
  const status = output.slice(0, space);
  const reply = output.slice(space + 1);
  if (reply === "" && status === "1") return { outcome: "closed" };
  if (Number(status) > 128)
    return { outcome: "foreign", detail: `no complete reply within ${readSeconds} s` };
  const [head = "", ...rest] = reply.split("\r\n\r\n");
  const statusLine = (head.split("\r\n")[0] ?? "").slice(0, 40).replace(/[^\x20-\x7e]/gu, "?");
  if (!/^HTTP\/1\.[01] 200\b/u.test(statusLine))
    return {
      outcome: "foreign",
      detail: statusLine === "" ? "replied without a status line" : `replied ${statusLine}`,
    };
  if (status !== "1") return { outcome: "foreign", detail: "a 200 with a NUL byte" };
  return rest.join("\r\n\r\n") === body
    ? { outcome: "passed" }
    : { outcome: "foreign", detail: "a 200 with another body" };
};

/**
 * One plain `GET` from the running database container to the API port's readiness route, read to
 * its end. Bash builtins only: the slim image has no coreutils.
 */
export const probeApiTls = Effect.fn("ApiTlsSupport.probe")(function* (
  spawner: ChildProcessSpawner.ChildProcessSpawner["Service"],
  target: EngineTarget,
  stack: ApiTlsStack,
  runtime: string,
  check: { readonly port: number; readonly path: string; readonly body: string },
  readSeconds = 5,
) {
  const failed = (message: string, detail: string, next: string) =>
    new ApiTlsCheckError({ message, detail, next });
  const unreachable = (detail: string) =>
    failed(
      `api.tls: containers can't reach the api port ${check.port} on ${runtime}`,
      detail,
      `let ${runtime} containers reach the api port, or turn off \`[api.tls]\`, then start the stack again`,
    );
  if (stack.database === undefined) return yield* unreachable("no database container");
  const names = yield* runRaw(
    spawner,
    target.engine,
    [
      "ps",
      "--filter",
      `label=com.supabase.stack=${stack.id}`,
      "--filter",
      `label=com.supabase.stack-root=${stack.root}`,
      "--filter",
      `label=com.supabase.instance=${stack.database}`,
      "--filter",
      "label=com.supabase.service=database",
      "--format",
      "{{.Names}}",
    ],
    target.argv,
  ).pipe(Effect.mapError((error) => unreachable(error.message)));
  /* One-off jobs of the database instance carry its labels too, under a `-task-` name. */
  const name = names
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.length > 0 && !/-task-[^-]+$/u.test(line));
  if (name === undefined) return yield* unreachable("no database container");
  const authority = `${DOCKER_HOST_ALIAS}:${check.port}`;
  /* Once connected it exits 0 and prints what `readApiTlsCheck` reads. */
  const script = `exec 3<>/dev/tcp/${DOCKER_HOST_ALIAS}/${check.port} && printf 'GET ${check.path} HTTP/1.0\\r\\nHost: ${authority}\\r\\nConnection: close\\r\\n\\r\\n' >&3 && { IFS= read -r -d '' -t ${readSeconds} reply <&3; printf '%s %s' "$?" "$reply"; }`;
  const output = yield* runRaw(
    spawner,
    target.engine,
    ["exec", name, "bash", "-c", script],
    target.argv,
  ).pipe(
    Effect.mapError((error) => unreachable(`probe failed for ${authority}: ${error.message}`)),
  );
  const read = readApiTlsCheck(output, check.body, readSeconds);
  if (read.outcome === "closed")
    return yield* failed(
      `api.tls: unsupported networking on ${runtime}: containers must reach the api from loopback`,
      "the database container's plain request was closed without a reply",
      "turn off `[api.tls]`, or use a runtime whose containers reach this host from loopback (on macOS: Docker Desktop, colima or Podman machine), then start the stack again",
    );
  if (read.outcome === "foreign")
    return yield* failed(
      `api.tls: the api port ${check.port} on ${runtime} isn't answering this stack's start check`,
      read.detail,
      `check what else listens on port ${check.port}, then start the stack again`,
    );
});

/**
 * The start check after a start or restart, when the API listener serves TLS: a failed probe
 * stops the stack's services and fails with what the probe saw.
 */
export const checkApiTlsReach = Effect.fn("ApiTlsSupport.checkReach")(function* (options: {
  readonly spawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
  readonly target: EngineTarget;
  readonly stack: ApiTlsStack;
  /** The engine every failure names, like `linux docker`. */
  readonly runtime: string;
  /** The API listener's port while it serves TLS; undefined skips the check. */
  readonly port: number | undefined;
  readonly path: string;
  /** Runs the probe while the readiness route answers with this body. */
  readonly answering: <A, E>(body: string, check: Effect.Effect<A, E>) => Effect.Effect<A, E>;
  readonly body: Effect.Effect<string>;
  readonly stop: Effect.Effect<unknown, { readonly message: string }>;
  readonly readSeconds?: number;
}) {
  const { stack } = options;
  if (options.port === undefined) return;
  const port = options.port;
  const body = yield* options.body;
  yield* options
    .answering(
      body,
      probeApiTls(
        options.spawner,
        options.target,
        stack,
        options.runtime,
        { port, path: options.path, body },
        options.readSeconds,
      ),
    )
    .pipe(
      Effect.catchTag("ApiTlsCheckError", (error) =>
        Effect.gen(function* () {
          yield* Effect.logWarning(`${error.message}: ${error.detail}`);
          const unstopped = yield* options.stop.pipe(
            Effect.as(undefined),
            Effect.catch((cause) =>
              Effect.logError(`api.tls: stopping the stack failed: ${cause.message}`).pipe(
                Effect.as(cause.message),
              ),
            ),
          );
          const recovery =
            unstopped === undefined
              ? `; its services stopped: ${error.next}`
              : `; its services did not stop (${unstopped}), run \`supabase stack stop --stack-id ${stack.id}\` to stop them`;
          return yield* new ApiTlsCheckError({
            message: `${error.message} (${error.detail})${recovery}`,
            detail: error.detail,
            next: error.next,
          });
        }),
      ),
    );
});
