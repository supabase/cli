#!/usr/bin/env node

// Ref 1: https://github.com/sanathkr/go-npm
// Ref 2: https://blog.xendit.engineer/how-we-repurposed-npm-to-publish-and-distribute-our-go-binaries-for-internal-cli-23981b80911b
"use strict";

import fetch from "node-fetch";
import path from "path";
import tar from "tar";
import zlib from "zlib";
import fs from "fs";

// Mapping from Node's `process.arch` to Golang's `$GOARCH`
const ARCH_MAPPING = {
  x64: "amd64",
  arm64: "arm64",
};

// Mapping between Node's `process.platform` to Golang's
const PLATFORM_MAPPING = {
  darwin: "darwin",
  linux: "linux",
  win32: "windows",
};

function validateConfiguration(packageJson) {
  if (!packageJson.version) {
    return "'version' property must be specified";
  }

  if (!packageJson.bin) {
    return "'bin' property must be specified";
  }

  if (!packageJson.url) {
    return "'url' property must be specified";
  }
}

async function parsePackageJson() {
  if (!ARCH_MAPPING[process.arch]) {
    throw Error(
      "Installation is not supported for this architecture: " + process.arch
    );
  }

  if (!PLATFORM_MAPPING[process.platform]) {
    throw Error(
      "Installation is not supported for this platform: " + process.platform
    );
  }

  const packageJsonPath = path.join(".", "package.json");
  const contents = await fs.promises.readFile(packageJsonPath);
  const packageJson = JSON.parse(contents);
  const error = validateConfiguration(packageJson);
  if (error) {
    throw Error("Invalid package.json: " + error);
  }

  // We have validated the config. It exists in all its glory
  const bin = packageJson.bin.toString();
  const binName = path.basename(bin);
  const binPath = path.dirname(bin);
  let url = packageJson.url.toString();
  let version = packageJson.version.toString();

  // strip the 'v' if necessary v0.0.1 => 0.0.1
  if (version[0] === "v") version = version.substr(1);

  // Interpolate variables in URL, if necessary
  url = url.replace(/{{arch}}/g, ARCH_MAPPING[process.arch]);
  url = url.replace(/{{platform}}/g, PLATFORM_MAPPING[process.platform]);
  url = url.replace(/{{version}}/g, version);
  url = url.replace(/{{bin_name}}/g, binName);

  return { binName, binPath, url, version };
}

const errGlobal = `Installing Supabase CLI as a global module is not supported.
Please use one of the supported package managers: https://github.com/supabase/cli#install-the-cli
`;

/**
 * Reads the configuration from application's package.json,
 * validates properties, copied the binary from the package and stores at
 * ./bin in the package's root.
 *
 *  See: https://docs.npmjs.com/files/package.json#bin
 */
async function main() {
  if (process.env.npm_config_global) {
    throw errGlobal;
  }

  const opts = await parsePackageJson();
  await fs.promises.mkdir(opts.binPath, { recursive: true });

  // First we will Un-GZip, then we will untar.
  const ungz = zlib.createGunzip();
  // Binary name on Windows has .exe suffix
  const ext = process.platform === "win32" ? ".exe" : "";
  const untar = tar.x({ cwd: opts.binPath }, [opts.binName + ext]);

  console.info("Downloading", opts.url);
  const resp = await fetch(opts.url);
  resp.body.pipe(ungz).pipe(untar);
  await new Promise((resolve, reject) => {
    untar.on("error", reject);
    untar.on("end", () => resolve());
  });

  // Creates a hardlink for npm to find the binary on Windows
  if (ext) {
    const bin = path.join(opts.binPath, opts.binName);
    await fs.promises.link(bin + ext, bin);
  }

  // Copy binary because yarn runs as postinstall
  if (process.env.npm_config_user_agent.startsWith("yarn/")) {
    const bin = path.join(opts.binPath, opts.binName);
    const link = path.join("..", ".bin", opts.binName);
    await fs.promises.symlink(bin, link);
  }

  // TODO: verify checksums
  console.info("Installed Supabase CLI successfully");
}

await main();
