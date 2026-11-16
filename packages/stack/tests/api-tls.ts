import { Config, Data, Deferred, Effect, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { createServer, type Socket } from "node:net";
import { networkInterfaces } from "node:os";
import { defaultArtifactSelection } from "../src/Artifacts.ts";
import { DOCKER_HOST_ALIAS, type EngineTarget } from "../src/runtime/Container.ts";

class ApiTlsFixtureError extends Data.TaggedError("ApiTlsFixtureError")<{
  readonly message: string;
}> {}

const external = Object.values(networkInterfaces())
  .flat()
  .find((entry) => entry?.family === "IPv4" && !entry.internal)?.address;

/** This host's first non-loopback IPv4; a test that needs one fails rather than skips without it. */
export const externalAddress =
  external === undefined
    ? Effect.die("no external IPv4 address to reach the API from the LAN side")
    : Effect.succeed(external);

/** Whether a peer address, `::ffff:`-mapped or not, is loopback. */
export const isLoopback = (address: string) => {
  const unmapped = address.startsWith("::ffff:") ? address.slice(7) : address;
  return unmapped === "::1" || /^127\.\d+\.\d+\.\d+$/u.test(unmapped);
};

/** Runs `command` to its end, answering its stdout, stderr and exit code. */
export const runCommand = (command: string, args: ReadonlyArray<string>) =>
  Effect.scoped(
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const child = yield* spawner.spawn(
        ChildProcess.make(command, args, { stdin: "ignore", stdout: "pipe", stderr: "pipe" }),
      );
      const [stdout, stderr, code] = yield* Effect.all(
        [
          Stream.mkString(Stream.decodeText(child.stdout)),
          Stream.mkString(Stream.decodeText(child.stderr)),
          child.exitCode,
        ],
        { concurrency: "unbounded" },
      );
      return { stdout, stderr, code: Number(code) };
    }),
  );

/**
 * A bash of at least 4 on this host, which the start check's probe needs, or none: bash 3.2
 * (macOS's `/bin/bash`) reports a `read -t` timeout like an end of input.
 */
export const hostBash = Effect.gen(function* () {
  for (const candidate of ["bash", "/opt/homebrew/bin/bash", "/usr/local/bin/bash"]) {
    const major = yield* runCommand(candidate, ["-c", 'printf %s "${BASH_VERSINFO[0]}"']).pipe(
      Effect.map(({ stdout, code }) => (code === 0 ? Number(stdout) : 0)),
      Effect.orElseSucceed(() => 0),
    );
    if (major >= 4) return candidate;
  }
  return undefined;
});

/**
 * The address a container of `target`'s engine arrives from at a listener on every interface of
 * this host, measured with the database image and a bash `/dev/tcp` request to the stack alias,
 * independently of the stack's own start check.
 */
export const containerPeer = (target: Pick<EngineTarget, "engine" | "argv">) =>
  Effect.scoped(
    Effect.gen(function* () {
      const peer = yield* Deferred.make<string>();
      /* An engine's forwarder may keep its side open after the container exits. */
      const sockets = new Set<Socket>();
      const server = createServer((socket) => {
        sockets.add(socket);
        socket.on("error", () => socket.destroy());
        Deferred.doneUnsafe(peer, Effect.succeed(socket.remoteAddress ?? ""));
        socket.end("HTTP/1.0 200 OK\r\nContent-Length: 4\r\n\r\npeer");
      });
      const port = yield* Effect.acquireRelease(
        Effect.callback<number, ApiTlsFixtureError>((resume) => {
          const onError = (cause: Error) =>
            resume(Effect.fail(new ApiTlsFixtureError({ message: cause.message })));
          server.once("error", onError);
          server.listen(0, "0.0.0.0", () => {
            server.off("error", onError);
            const address = server.address();
            resume(
              address === null || typeof address === "string"
                ? Effect.fail(new ApiTlsFixtureError({ message: "no listener address" }))
                : Effect.succeed(address.port),
            );
          });
          return Effect.sync(() => server.off("error", onError));
        }),
        () =>
          Effect.callback<void>((resume) => {
            server.close(() => resume(Effect.void));
            for (const socket of sockets) socket.destroy();
          }),
      );
      const script = `exec 3<>/dev/tcp/${DOCKER_HOST_ALIAS}/${port} && printf 'GET / HTTP/1.0\\r\\n\\r\\n' >&3 && IFS= read -r -d '' -t 5 reply <&3; printf '%s' "$reply"`;
      const probe = yield* runCommand(target.engine, [
        ...target.argv,
        "run",
        "--rm",
        "--add-host",
        `${DOCKER_HOST_ALIAS}:host-gateway`,
        "--entrypoint",
        "bash",
        defaultArtifactSelection().database.image,
        "-c",
        script,
      ]);
      if (probe.code !== 0 || !probe.stdout.endsWith("peer"))
        return yield* new ApiTlsFixtureError({
          message: `the container peer probe failed (${probe.code}): ${probe.stdout}${probe.stderr}`,
        });
      return yield* Deferred.await(peer);
    }),
  );

/** Whether this run is on CI, where a test whose host prerequisites are missing fails, not skips. */
export const onCi = Config.String("CI").pipe(
  Config.withDefault(""),
  Config.map((value) => value !== ""),
);
