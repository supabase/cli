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
  let binName = path.basename(packageJson.bin);
  const binPath = path.dirname(packageJson.bin);
  let url = packageJson.url;
  let version = packageJson.version;

  // strip the 'v' if necessary v0.0.1 => 0.0.1
  if (version[0] === "v") version = version.substr(1);

  // Interpolate variables in URL, if necessary
  url = url.replace(/{{arch}}/g, ARCH_MAPPING[process.arch]);
  url = url.replace(/{{platform}}/g, PLATFORM_MAPPING[process.platform]);
  url = url.replace(/{{version}}/g, version);
  url = url.replace(/{{bin_name}}/g, binName);

  // Binary name on Windows has .exe suffix
  if (process.platform === "win32") {
    binName += ".exe";
  }

  return { binName, binPath, url, version };
}

/**
 * Reads the configuration from application's package.json,
 * validates properties, copied the binary from the package and stores at
 * ./bin in the package's root. NPM already has support to install binary files
 * specific locations when invoked with "npm install -g"
 *
 *  See: https://docs.npmjs.com/files/package.json#bin
 */
async function main() {
  const opts = await parsePackageJson();
  await fs.promises.mkdir(opts.binPath, { recursive: true });

  // First we will Un-GZip, then we will untar. So once untar is completed,
  // binary is downloaded into `downloadPath`. Verify the binary and call it good
  const ungz = zlib.createGunzip();
  const untar = tar.x({ cwd: opts.binPath }, [opts.binName]);

  console.info("Downloading", opts.url);
  const resp = await fetch(opts.url);
  resp.body.pipe(ungz).pipe(untar);
  await new Promise((resolve, reject) => {
    untar.on("error", reject);
    untar.on("end", () => resolve());
  });

  // TODO: verify checksums
  console.info("Installed Supabase CLI successfully");
}

await main();
