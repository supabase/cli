import * as net from "node:net";
import process from "node:process";
import { Agent, type Dispatcher } from "undici";

/**
 * `RequestInit` plus the per-request connection options each runtime honours: Bun reads `tls`,
 * Node's fetch reads an undici `dispatcher`.
 */
export interface TlsFetchRequestInit extends RequestInit {
  tls?: { ca?: string; serverName?: string };
  dispatcher?: Dispatcher;
}

/** Bun's fetch honours `tls` but ignores `dispatcher`; Node's fetch does the opposite. */
export const runsOnBun = process.versions.bun !== undefined;

/** Fetch options that make the request trust `ca` in addition to the default roots. */
export function trustCaInit(ca: string): TlsFetchRequestInit {
  return runsOnBun ? { tls: { ca } } : { dispatcher: new Agent({ connect: { ca } }) };
}

const pinnedAgents = new Map<string, Agent>();

/**
 * Node-side fetch options that dial `address` for requests to `host` while the URL, `Host`
 * header, SNI, and certificate checks keep using `host` (Node's fetch drops a caller-set `Host`
 * header, so rewriting the URL to the IP would send the wrong one).
 */
export function pinAddressInit(host: string, address: string): TlsFetchRequestInit {
  const key = `${host}\0${address}`;
  let agent = pinnedAgents.get(key);
  if (agent === undefined) {
    const family = net.isIP(address);
    agent = new Agent({
      connect: {
        lookup: (_hostname, options, callback) => {
          if (options.all === true) callback(null, [{ address, family }]);
          else callback(null, address, family);
        },
      },
    });
    pinnedAgents.set(key, agent);
  }
  return { dispatcher: agent };
}
