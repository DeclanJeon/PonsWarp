import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Multi-device LAN / Tailscale access during `next dev`.
  // Host only (no scheme/port). Next blocks off-localhost dev resources otherwise.
  allowedDevOrigins: [
    "100.65.42.93",
    "100.109.210.63",
    "192.168.219.104",
    "192.168.219.103",
    "127.0.0.1",
  ],
};

export default nextConfig;
