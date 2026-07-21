import { createMDX } from "fumadocs-mdx/next";
import type { NextConfig } from "next";

const config: NextConfig = {
  experimental: {
    useTypeScriptCli: true,
  },
  reactStrictMode: true,
};

const withMDX = createMDX();
export default withMDX(config);
