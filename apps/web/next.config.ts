import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Next 16.4.5 stalls during Cache Components prerendering on Windows and
  // clean Linux installs. Keep standard prerendering until that is resolved.
  cacheComponents: false,
  partialPrefetching: false,
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
