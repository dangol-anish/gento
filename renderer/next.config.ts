import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  output: "export",
  // Electron loads the exported app via `file://.../index.html`. Next's default
  // asset paths are root-absolute (`/_next/...`) which break under `file://`.
  // A relative asset prefix keeps CSS/JS paths working in packaged builds.
  assetPrefix: "./",
  images: {
    unoptimized: true,
  },
  eslint: {
    ignoreDuringBuilds: true,
  },
};

export default nextConfig;
