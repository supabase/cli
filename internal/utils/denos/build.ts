import { encode } from "https://deno.land/std@0.127.0/encoding/base64.ts";
import * as path from "https://deno.land/std@0.127.0/path/mod.ts";
import { writeAll } from "https://deno.land/std@0.162.0/streams/conversion.ts";
import { compress } from "https://deno.land/x/brotli@0.1.7/mod.ts";
import { build } from "https://deno.land/x/eszip@v0.35.0/mod.ts";

async function buildAndWrite(entrypointPath: string, importMapPath: string) {
  const entrypointUrl = path.toFileUrl(entrypointPath).href
  const importMapUrl = path.toFileUrl(importMapPath).href

  const eszip = await build([entrypointUrl], async (specifier: string) => {
    const url = new URL(specifier);
    if (url.protocol === "file:") {
      console.error(specifier);
      const actualPath = url.pathname;

      try {
        const content = await Deno.readTextFile(actualPath);
        return {
          kind: "module",
          specifier,
          content,
        };
      } catch (e) {
        if (
          (e instanceof Deno.errors.NotFound) &&
          actualPath === importMapPath
        ) {
          // if there's no import_map.json, set an empty one
          return {
            kind: "module",
            specifier,
            content: `{ "imports": {} }`,
          };
        } else {
          throw e;
        }
      }
    }

    return load(specifier);
  }, importMapUrl);
  // compress ESZIP payload using Brotli
  const compressed = compress(eszip);

  // add a marker frame to the start of the payload
  const marker = new TextEncoder().encode("EZBR");

  const combinedPayload = new Uint8Array(marker.length + compressed.length);
  combinedPayload.set(marker);
  combinedPayload.set(compressed, marker.length);

  await writeAll(Deno.stdout, combinedPayload);
}

buildAndWrite(...Deno.args);

// Adapted from https://github.com/denoland/deno/blob/bacbf949256e32ca84e7f11c0171db7d9a644b44/cli/auth_tokens.rs#L38

function parseDenoAuthTokens(
  denoAuthTokens: string | undefined,
): [string, string][] {
  const tokens: [string, string][] = [];

  if (denoAuthTokens) {
    denoAuthTokens.split(";").forEach((tokenAndHost) => {
      if (!tokenAndHost.includes("@")) {
        console.warn("Badly formed auth token discarded.");
        return;
      }

      const sepIdx = tokenAndHost.lastIndexOf("@");
      const token = tokenAndHost.substring(0, sepIdx);
      const host = tokenAndHost.substring(sepIdx + 1);

      if (token.includes(":")) {
        const sepIdx = token.lastIndexOf(":");
        const username = token.substring(0, sepIdx);
        const password = token.substring(sepIdx + 1);
        tokens.push([host, `Basic ${encode(`${username}:${password}`)}`]);
      } else {
        tokens.push([host, `Bearer ${token}`]);
      }
    });
  }

  return tokens;
}

function findMatchingDenoAuthToken(
  hostToMatch: string,
  denoAuthTokens: [string, string][],
): string | undefined {
  const matchingPair = denoAuthTokens.find(([host, _]) =>
    hostToMatch.endsWith(host)
  );
  return matchingPair?.[1];
}

// Adapted from https://github.com/denoland/eszip/blob/b7043bf0b7938f8d91216e1541d4bd4fb8819a3d/lib/loader.ts
// TODO: Upstream the change.

interface LoadResponseModule {
  /** A module with code has been loaded. */
  kind: "module";
  /** The string URL of the resource. If there were redirects, the final
   * specifier should be set here, otherwise the requested specifier. */
  specifier: string;
  /** For remote resources, a record of headers should be set, where the key's
   * have been normalized to be lower case values. */
  headers?: Record<string, string>;
  /** The string value of the loaded resources. */
  content: string;
}

interface LoadResponseExternalBuiltIn {
  /** The loaded module is either _external_ or _built-in_ to the runtime. */
  kind: "external" | "builtIn";
  /** The string URL of the resource. If there were redirects, the final
   * specifier should be set here, otherwise the requested specifier. */
  specifier: string;
}

type LoadResponse = LoadResponseModule | LoadResponseExternalBuiltIn;

async function load(
  specifier: string,
): Promise<LoadResponse | undefined> {
  const url = new URL(specifier);
  try {
    switch (url.protocol) {
      case "file:": {
        const content = await Deno.readTextFile(url);
        return {
          kind: "module",
          specifier,
          content,
        };
      }
      case "http:":
      case "https:": {
        const requestHeaders: { Authorization?: string } = {};
        {
          const denoAuthTokens = parseDenoAuthTokens(
            Deno.env.get("DENO_AUTH_TOKENS"),
          );
          const matchingToken = findMatchingDenoAuthToken(
            url.host.toLowerCase(),
            denoAuthTokens,
          );
          if (matchingToken) {
            requestHeaders.Authorization = matchingToken;
          }
        }
        const response = await fetch(String(url), {
          redirect: "follow",
          headers: requestHeaders,
        });
        if (response.status !== 200) {
          // ensure the body is read as to not leak resources
          await response.arrayBuffer();
          return undefined;
        }
        const content = await response.text();
        const headers: Record<string, string> = {};
        for (const [key, value] of response.headers) {
          headers[key.toLowerCase()] = value;
        }
        return {
          kind: "module",
          specifier: response.url,
          headers,
          content,
        };
      }
      default:
        return undefined;
    }
  } catch {
    return undefined;
  }
}
