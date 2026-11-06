import { networkInterfaces } from "node:os";
import { Data, Effect } from "effect";
import type { ChildProcessSpawner } from "effect/process";
import { DOCKER_HOST_ALIAS, runRaw, type EngineTarget } from "./Container.ts";

const IPV4 = /^(?:\d{1,3}\.){3}\d{1,3}$/u;
const IPV4_CIDR = /^(?:\d{1,3}\.){3}\d{1,3}\/\d{1,2}$/u;

const platformName = (platform: NodeJS.Platform) =>
  platform === "darwin" ? "macos" : platform === "win32" ? "windows" : platform;

/**
 * Names the runtime and reads the IPv4 subnets of the engine's default network, the one every
 * stack container joins; an unreadable inspect is logged and leaves them out for the self-check.
 */
export const apiTlsPeers = Effect.fn("ApiTlsSupport.peers")(function* (
  spawner: ChildProcessSpawner.ChildProcessSpawner["Service"],
  target: EngineTarget | undefined,
  platform: NodeJS.Platform = process.platform,
) {
  const os = platformName(platform);
  if (target === undefined) return { runtime: `${os} native`, subnets: [] };
  const [network, field] =
    target.engine === "docker" ? ["bridge", ".IPAM.Config"] : ["podman", ".Subnets"];
  const text = yield* runRaw(
    spawner,
    target.engine,
    ["network", "inspect", network, "--format", `{{range ${field}}}{{.Subnet}} {{end}}`],
    target.argv,
  ).pipe(
    Effect.catch((error) =>
      Effect.logWarning(
        `api.tls: can't read the ${target.engine} ${network} network's subnets, so only the start check admits containers: ${error.message}`,
      ).pipe(Effect.as("")),
    ),
  );
  const rootless = target.engine === "podman" && target.rootless ? "rootless " : "";
  return {
    runtime: `${os} ${rootless}${target.engine}`,
    subnets: text.split(/\s+/u).filter((subnet) => IPV4_CIDR.test(subnet)),
  };
});

const ipv4ToInt = (address: string) =>
  address.split(".").reduce((value, octet) => value * 256 + Number(octet), 0);

const inSubnet = (address: string, cidr: string) => {
  const [network = "", bits = "32"] = cidr.split("/");
  const size = 2 ** (32 - Number(bits));
  return (
    IPV4.test(address) &&
    Math.floor(ipv4ToInt(address) / size) === Math.floor(ipv4ToInt(network) / size)
  );
};

/* Every address this host holds now; a packet from outside carrying one is dropped as martian. */
const hostAddresses = () =>
  new Set(
    Object.values(networkInterfaces())
      .flatMap((entries) => entries ?? [])
      .map((entry) => entry.address),
  );

/**
 * Plain HTTP on a TLS API port: loopback, an address of this host (host processes and user-mode
 * relays connect from one), or an engine network subnet while this host holds an address in it,
 * read per connection since a bridge appears once containers run. A routed LAN peer has none.
 */
export const plainPeerAllowed =
  (subnets: ReadonlyArray<string>, localAddresses: () => ReadonlySet<string> = hostAddresses) =>
  (address: string): boolean => {
    if (address === "::1" || inSubnet(address, "127.0.0.0/8")) return true;
    const local = [...localAddresses()];
    return (
      local.includes(address) ||
      subnets.some(
        (subnet) => inSubnet(address, subnet) && local.some((own) => inSubnet(own, subnet)),
      )
    );
  };

/** The self-check request target; its secret token, redacted in access logs, lets an unlisted peer be learned. */
export const apiTlsSelfCheckPath = (token: string) => `/__api_tls_self_check?token=${token}`;

class ApiTlsSelfCheckError extends Data.TaggedError("ApiTlsSelfCheckError")<{
  readonly message: string;
  /** What the probe saw: no database container, the engine's error, or the reply's first bytes. */
  readonly detail: string;
}> {}

/**
 * One plain request from the running database container (its `host-gateway` alias is the one
 * `pg_net` uses) to the API port, proving containers reach it before start reports success.
 * Bash builtins only: the slim image has no coreutils.
 */
export const selfCheckApiTls = Effect.fn("ApiTlsSupport.selfCheck")(function* (
  spawner: ChildProcessSpawner.ChildProcessSpawner["Service"],
  target: EngineTarget,
  stack: { readonly id: string; readonly root: string },
  runtime: string,
  port: number,
  path: string,
) {
  const failedWith = (detail: string) =>
    new ApiTlsSelfCheckError({
      message: `api.tls: containers can't reach the api on ${runtime}`,
      detail,
    });
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
      "label=com.supabase.service=database",
      "--format",
      "{{.Names}}",
    ],
    target.argv,
  ).pipe(Effect.mapError((error) => failedWith(error.message)));
  const name = names
    .split("\n")
    .find((line) => line.trim().length > 0)
    ?.trim();
  if (name === undefined) return yield* failedWith("no database container");
  const authority = `${DOCKER_HOST_ALIAS}:${port}`;
  const script = `exec 3<>/dev/tcp/${DOCKER_HOST_ALIAS}/${port} && printf 'GET ${path} HTTP/1.0\\r\\nHost: ${authority}\\r\\n\\r\\n' >&3 && read -r -t 5 -n 9 reply <&3 && printf %s "$reply"`;
  const reply = yield* runRaw(
    spawner,
    target.engine,
    ["exec", name, "bash", "-c", script],
    target.argv,
  ).pipe(Effect.mapError((error) => failedWith(error.message)));
  if (!reply.startsWith("HTTP/1.")) return yield* failedWith(`reply ${reply.slice(0, 40)}`);
});

/**
 * The self-check after a start or restart, when the stack saved TLS and has an API port. A failed
 * read of the saved TLS or a failed probe stops the stack's services and fails with the detail,
 * the probe's token redacted.
 */
export const checkApiTlsReach = Effect.fn("ApiTlsSupport.checkReach")(function* (options: {
  readonly spawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
  readonly target: EngineTarget;
  readonly stack: { readonly id: string; readonly root: string };
  readonly apiTls: Effect.Effect<
    { readonly runtime: string; readonly selfCheck: string } | undefined,
    { readonly message: string }
  >;
  readonly port: number | undefined;
  readonly stop: Effect.Effect<unknown, { readonly message: string }>;
  /** The peers the probe was let in as, saved so later owners admit them too. */
  readonly learned: (token: string) => Effect.Effect<ReadonlyArray<string>>;
  readonly saveLearned: (
    peers: ReadonlyArray<string>,
  ) => Effect.Effect<void, { readonly message: string }>;
}) {
  const { stack } = options;
  const stopThenFail = (message: string, detail: string) =>
    Effect.gen(function* () {
      yield* Effect.logWarning(`${message}: ${detail}`);
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
          ? ""
          : `; its services did not stop (${unstopped}), run \`supabase stack stop --stack-id ${stack.id}\` to stop them`;
      return yield* new ApiTlsSelfCheckError({
        message: `${message} (${detail})${recovery}`,
        detail,
      });
    });
  const apiTls = yield* options.apiTls.pipe(
    Effect.catch((cause) =>
      stopThenFail("api.tls: can't read the stack's saved TLS", cause.message),
    ),
  );
  if (apiTls === undefined || options.port === undefined) return;
  yield* selfCheckApiTls(
    options.spawner,
    options.target,
    stack,
    apiTls.runtime,
    options.port,
    apiTlsSelfCheckPath(apiTls.selfCheck),
  ).pipe(
    Effect.catchTag("ApiTlsSelfCheckError", (error) =>
      stopThenFail(error.message, error.detail.replaceAll(apiTls.selfCheck, "<redacted>")),
    ),
  );
  const learned = yield* options.learned(apiTls.selfCheck);
  if (learned.length === 0) return;
  yield* Effect.logInfo(`api.tls: plain api peers learned by the self-check: ${learned}`);
  /* Best effort: this owner keeps them in memory, only a later owner would miss them. */
  yield* options
    .saveLearned(learned)
    .pipe(
      Effect.catch((cause) =>
        Effect.logWarning(`api.tls: can't save the peers the start check let in: ${cause.message}`),
      ),
    );
});
