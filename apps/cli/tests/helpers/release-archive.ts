import { zstdCompressSync } from "node:zlib";

const encoder = new TextEncoder();

/** A `.tar.zst` holding an empty executable file at each of `paths`. */
export const releaseArchive = (paths: ReadonlyArray<string>): Uint8Array => {
  const bytes = new Uint8Array((paths.length + 2) * 512);
  for (const [index, name] of paths.entries()) {
    const header = bytes.subarray(index * 512, (index + 1) * 512);
    header.set(encoder.encode(name), 0);
    header.set(encoder.encode("0000755\0"), 100);
    header.set(encoder.encode("0000000\0"), 108);
    header.set(encoder.encode("0000000\0"), 116);
    header.set(encoder.encode("00000000000\0"), 124);
    header[156] = 48;
    header.set(encoder.encode("ustar\0"), 257);
    header.fill(32, 148, 156);
    const checksum = header
      .reduce((sum, value) => sum + value, 0)
      .toString(8)
      .padStart(6, "0");
    header.set(encoder.encode(`${checksum}\0 `), 148);
  }
  return zstdCompressSync(bytes);
};
