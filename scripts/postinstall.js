#!/usr/bin/env node

// Ref 1: https://github.com/sanathkr/go-npm
// Ref 2: https://blog.xendit.engineer/how-we-repurposed-npm-to-publish-and-distribute-our-go-binaries-for-internal-cli-23981b80911b
"use strict";

import binLinks from "bin-links";
import { createHash } from "crypto";
import fs from "fs";
import fetch from "node-fetch";
import path from "path";
import tar from "tar";
import zlib from "zlib";
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

const arch = ARCH_MAPPING[process.arch];

const platform = PLATFORM_MAPPING[process.platform];
// TODO: import pkg from "../package.json" assert { type: "json" };
const readPackageJson = async () => {
  const packageJsonPath = path.join(".", "package.json");
  const contents = await fs.promises.readFile(packageJsonPath);
  return JSON.parse(contents);
};

const parsePackageJson = (packageJson) => {
  if (!arch) {
    throw Error(
      "Installation is not supported for this architecture: " + process.arch
    );
  }

  if (!platform) {
    throw Error(
      "Installation is not supported for this platform: " + process.platform
    );
  }

  // Build the download url from package.json
  const pkgName = packageJson.name;
  const version = packageJson.version;
  const repo = packageJson.repository;
  const url = `https://github.com/${repo}/releases/download/v${version}/${pkgName}_${platform}_${arch}.tar.gz`;

  let binPath = path.join("bin", "supabase");
  if (platform == "windows") {
    binPath += ".exe";
  }

  return { binPath, url };
};

const parseCheckSumFile = async (packageJson) => {
  const version = packageJson.version;
  const pkgName = packageJson.name;
  const pkgNameWithPlatform = `${pkgName}_${platform}_${arch}.tar.gz`;
  const checksumFileUrl = `https://github.com/supabase/cli/releases/download/v${version}/${pkgName}_${version}_checksums.txt`;

  // Fetch the checksum file
  const response = await fetch(checksumFileUrl);
  if (response.ok) {
    const checkSumContent = await response.text();
    const lines = checkSumContent.split("\n");

    let checksumForRequiredPackage = null;

    // Find the checksum for the required package
    for (const line of lines) {
      const [checksum, packageName] = line.split(/\s+/);
      if (packageName === pkgNameWithPlatform) {
        checksumForRequiredPackage = checksum;
        break;
      }
    }

    if (checksumForRequiredPackage) {
      return checksumForRequiredPackage;
    } else {
      console.error("Error finding checksum for package", pkgNameWithPlatform);
    }
  } else {
    console.error(
      "Could not fetch checksum file",
      response.status,
      response.statusText
    );
  }
};

const errGlobal = `Installing Supabase CLI as a global module is not supported.
Please use one of the supported package managers: https://github.com/supabase/cli#install-the-cli
`;

/**
 * Reads the configuration from application's package.json,
 * downloads the binary from package url and stores at
 * ./bin in the package's root.
 *
 *  See: https://docs.npmjs.com/files/package.json#bin
 */
async function main() {
  const yarnGlobal = JSON.parse(
    process.env.npm_config_argv || "{}"
  ).original?.includes("global");
  if (process.env.npm_config_global || yarnGlobal) {
    throw errGlobal;
  }

  const pkg = await readPackageJson();
  const hash = createHash("sha256");
  const expectedChecksum = await parseCheckSumFile(pkg);
  const { binPath, url } = parsePackageJson(pkg);
  const binDir = path.dirname(binPath);
  await fs.promises.mkdir(binDir, { recursive: true });

  // First we will Un-GZip, then we will untar.
  const ungz = zlib.createGunzip();
  const binName = path.basename(binPath);
  const untar = tar.x({ cwd: binDir }, [binName]);

  console.info("Downloading", url);
  const resp = await fetch(url);
  resp.body
    .on("data", (chunk) => {
      hash.update(chunk);
    })
    .pipe(ungz);

  ungz.on("end", () => {
    const calculatedChecksum = hash.digest("hex");

    if (calculatedChecksum === expectedChecksum) {
      console.info("Checksum verified.");
    } else {
      console.error("Checksum mismatch. Downloaded data might be corrupted.");
    }
  });

  ungz.pipe(untar);

  await new Promise((resolve, reject) => {
    untar.on("error", reject);
    untar.on("end", () => resolve());
  });

  // Link the binaries in postinstall to support yarn
  await binLinks({
    path: path.resolve("."),
    pkg: { ...pkg, bin: { [pkg.name]: binPath } },
  });

  console.info("Installed Supabase CLI successfully");
}

await main();
