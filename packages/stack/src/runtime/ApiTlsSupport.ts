import { networkInterfaces } from "node:os";
import { Data, Effect } from "effect";
import type { ChildProcessSpawner } from "effect/process";
import { DOCKER_HOST_ALIAS, runRaw, type EngineTarget } from "./Container.ts";

const IPV4 = /^(?:\d{1,3}\.){3}\d{1,3}$/u;
const IPV4_CIDR = /^(?:\d{1,3}\.){3}\d{1,3}\/\d{1,2}$/u;

const platformName = (platform: NodeJS.Platform) =>
  platform === "darwin" ? "macos" : platform === "win32" ? "windows" : platform;

/** An engine network the plain peer rule admits: its IPv4 subnet and its gateway address. */
export interface ApiTlsNetwork {
  readonly subnet: string;
  readonly gateway: string;
}

/** Where a self-check's request came from and the address of this host it connected to. */
export interface ApiTlsArrival {
  readonly peer: string;
  readonly local: string;
}

/** The runtime a failed self-check names, like `macos rootless podman`. */
export const apiTlsRuntimeLabel = (
  target: EngineTarget,
  platform: NodeJS.Platform = process.platform,
) => {
  const rootless = target.engine === "podman" && target.rootless ? "rootless " : "";
  return `${platformName(platform)} ${rootless}${target.engine}`;
};

/**
 * Reads the IPv4 subnets and gateways of the engine's default network, the one every stack
 * container joins; an unreadable inspect is logged and leaves them out for the self-check, which
 * reads the database container's own networks.
 */
export const apiTlsPeers = Effect.fn("ApiTlsSupport.peers")(function* (
  spawner: ChildProcessSpawner.ChildProcessSpawner["Service"],
  target: EngineTarget | undefined,
) {
  if (target === undefined) return [];
  const [network, field] =
    target.engine === "docker" ? ["bridge", ".IPAM.Config"] : ["podman", ".Subnets"];
  const text = yield* runRaw(
    spawner,
    target.engine,
    [
      "network",
      "inspect",
      network,
      "--format",
      `{{range ${field}}}{{.Subnet}} {{.Gateway}}{{println}}{{end}}`,
    ],
    target.argv,
  ).pipe(
    Effect.catch((error) =>
      Effect.logWarning(
        `api.tls: can't read the ${target.engine} ${network} network's subnets, so only the start check admits containers: ${error.message}`,
      ).pipe(Effect.as("")),
    ),
  );
  return parseNetworks(text);
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

const ipv4FromInt = (value: number) =>
  [24, 16, 8, 0].map((shift) => Math.floor(value / 2 ** shift) % 256).join(".");

/* One `<address>/<bits> <gateway>` per line; a line without both in IPv4 is left out. */
const parseNetworks = (text: string): ReadonlyArray<ApiTlsNetwork> =>
  text.split("\n").flatMap((line) => {
    const [cidr = "", gateway = ""] = line.trim().split(/\s+/u);
    if (!IPV4_CIDR.test(cidr) || !IPV4.test(gateway)) return [];
    const [address = "", bits = "32"] = cidr.split("/");
    const size = 2 ** (32 - Number(bits));
    const base = ipv4FromInt(Math.floor(ipv4ToInt(address) / size) * size);
    return [{ subnet: `${base}/${bits}`, gateway }];
  });

/* Every address this host holds now; a packet from outside carrying one is dropped as martian. */
const hostAddresses = () =>
  new Set(
    Object.values(networkInterfaces())
      .flatMap((entries) => entries ?? [])
      .map((entry) => entry.address),
  );

const loopbackPeer = (peer: string) => peer === "::1" || inSubnet(peer, "127.0.0.0/8");

/**
 * Plain HTTP on a TLS API port: loopback, an address of this host (host processes and user-mode
 * relays connect from one), or a peer in an engine network that connected to that network's
 * gateway, the address its containers reach this host at; a routed LAN or VPN peer inside the same
 * range connects to another address of this host.
 */
export const plainPeerAllowed =
  (
    networks: ReadonlyArray<ApiTlsNetwork>,
    localAddresses: () => ReadonlySet<string> = hostAddresses,
  ) =>
  (peer: string, local: string): boolean =>
    loopbackPeer(peer) ||
    localAddresses().has(peer) ||
    networks.some(
      (network) =>
        network.gateway !== "" && local === network.gateway && inSubnet(peer, network.subnet),
    );

/* Each network, and again at the local address a self-check from inside it arrived on when this
   host holds its gateway, that address is outside it, and the peer is not loopback or this host. */
const arrivalGateways = (
  networks: ReadonlyArray<ApiTlsNetwork>,
  arrivals: ReadonlyArray<ApiTlsArrival>,
  host: ReadonlySet<string>,
) => {
  const inside = arrivals.filter(
    ({ peer }) => IPV4.test(peer) && !inSubnet(peer, "127.0.0.0/8") && !host.has(peer),
  );
  return networks.flatMap((network) => [
    network,
    ...(network.gateway !== "" && host.has(network.gateway)
      ? inside
          .filter(
            ({ peer, local }) =>
              local !== network.gateway &&
              inSubnet(peer, network.subnet) &&
              !inSubnet(local, network.subnet),
          )
          .map(({ local }) => ({ subnet: network.subnet, gateway: local }))
      : []),
  ]);
};

/**
 * `plainPeerAllowed`, plus each self-check arrival on its exact peer and local address, and the
 * peers of its engine network at that arrival's local address, as `arrivalGateways` derives them.
 */
export const plainPeerAdmitted =
  (
    networks: ReadonlyArray<ApiTlsNetwork>,
    arrivals: ReadonlyArray<ApiTlsArrival>,
    localAddresses: () => ReadonlySet<string> = hostAddresses,
  ) =>
  (peer: string, local: string): boolean => {
    if (loopbackPeer(peer)) return true;
    if (arrivals.some((arrival) => arrival.peer === peer && arrival.local === local)) return true;
    /* One snapshot per connection. */
    const host = localAddresses();
    return plainPeerAllowed(arrivalGateways(networks, arrivals, host), () => host)(peer, local);
  };

/** The self-check request target; its secret token, redacted in access logs, lets an unlisted peer be learned. */
export const apiTlsSelfCheckPath = (token: string) => `/__api_tls_self_check?token=${token}`;

/** The stack the self-check probes from, by its primary database instance. */
interface ApiTlsStack {
  readonly id: string;
  readonly root: string;
  readonly database: string | undefined;
}

class ApiTlsSelfCheckError extends Data.TaggedError("ApiTlsSelfCheckError")<{
  readonly message: string;
  /** What the probe saw: no database container, the engine's error, or the reply's first bytes. */
  readonly detail: string;
}> {}

/**
 * One plain request from the running database container (its `host-gateway` alias is the one
 * `pg_net` uses) to the API port, proving containers reach it before start reports success, then
 * the container's networks, which every stack container shares. Bash builtins only: the slim
 * image has no coreutils.
 */
export const selfCheckApiTls = Effect.fn("ApiTlsSupport.selfCheck")(function* (
  spawner: ChildProcessSpawner.ChildProcessSpawner["Service"],
  target: EngineTarget,
  stack: ApiTlsStack,
  runtime: string,
  port: number,
  path: string,
) {
  const failedWith = (detail: string) =>
    new ApiTlsSelfCheckError({
      message: `api.tls: containers can't reach the api on ${runtime}`,
      detail,
    });
  if (stack.database === undefined) return yield* failedWith("no database container");
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
  ).pipe(Effect.mapError((error) => failedWith(error.message)));
  /* One-off jobs of the database instance carry its labels too, under a `-task-` name. */
  const name = names
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.length > 0 && !/-task-[^-]+$/u.test(line));
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
  return yield* runRaw(
    spawner,
    target.engine,
    [
      "inspect",
      name,
      "--format",
      "{{range .NetworkSettings.Networks}}{{.IPAddress}}/{{.IPPrefixLen}} {{.Gateway}}{{println}}{{end}}",
    ],
    target.argv,
  ).pipe(
    Effect.map(parseNetworks),
    Effect.catch((error) =>
      Effect.logWarning(
        `api.tls: can't read the database container's networks, so later owners keep the default network's: ${error.message}`,
      ).pipe(Effect.as([])),
    ),
  );
});

/**
 * The self-check after a start or restart, when the stack saved TLS and has an API port. A failed
 * read of the saved TLS or a failed probe stops the stack's services and fails with the detail,
 * the probe's token redacted.
 */
export const checkApiTlsReach = Effect.fn("ApiTlsSupport.checkReach")(function* (options: {
  readonly spawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
  readonly target: EngineTarget;
  readonly stack: ApiTlsStack;
  /** Named by the failure when containers can't reach the API. */
  readonly runtime: string;
  readonly apiTls: Effect.Effect<
    { readonly selfCheck: string } | undefined,
    { readonly message: string }
  >;
  readonly port: number | undefined;
  readonly stop: Effect.Effect<unknown, { readonly message: string }>;
  /**
   * Admits the database container's networks found by the probe, none when unread, and returns
   * the arrivals the probe was let in as; both are saved so later owners admit them too.
   */
  readonly learned: (
    token: string,
    networks: ReadonlyArray<ApiTlsNetwork>,
  ) => Effect.Effect<ReadonlyArray<ApiTlsArrival>>;
  readonly saveLearned: (learned: {
    readonly learnedArrivals: ReadonlyArray<ApiTlsArrival>;
    readonly networks: ReadonlyArray<ApiTlsNetwork>;
  }) => Effect.Effect<void, { readonly message: string }>;
}) {
  const { stack } = options;
  /* `next` is what to do once the services stopped. */
  const stopThenFail = (message: string, detail: string, next: string) =>
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
          ? `; its services stopped: ${next}`
          : `; its services did not stop (${unstopped}), run \`supabase stack stop --stack-id ${stack.id}\` to stop them`;
      return yield* new ApiTlsSelfCheckError({
        message: `${message} (${detail})${recovery}`,
        detail,
      });
    });
  const apiTls = yield* options.apiTls.pipe(
    Effect.catch((cause) =>
      stopThenFail(
        "api.tls: can't read the stack's saved TLS",
        cause.message,
        "start the stack again",
      ),
    ),
  );
  if (apiTls === undefined || options.port === undefined) return;
  const networks = yield* selfCheckApiTls(
    options.spawner,
    options.target,
    stack,
    options.runtime,
    options.port,
    apiTlsSelfCheckPath(apiTls.selfCheck),
  ).pipe(
    Effect.catchTag("ApiTlsSelfCheckError", (error) =>
      stopThenFail(
        error.message,
        error.detail.replaceAll(apiTls.selfCheck, "<redacted>"),
        `let ${options.runtime} containers reach the api port, or turn off \`[api.tls]\`, then start the stack again`,
      ),
    ),
  );
  const learned = yield* options.learned(apiTls.selfCheck, networks);
  if (learned.length > 0)
    yield* Effect.logInfo(
      `api.tls: plain api peers learned by the self-check: ${learned.map(({ peer, local }) => `${peer}@${local}`)}`,
    );
  if (learned.length === 0 && networks.length === 0) return;
  /* Best effort: this owner keeps them in memory, only a later owner would miss them. */
  yield* options
    .saveLearned({ learnedArrivals: learned, networks })
    .pipe(
      Effect.catch((cause) =>
        Effect.logWarning(`api.tls: can't save the peers the start check let in: ${cause.message}`),
      ),
    );
});
