import type { NextConfig } from "next";

// The backend origin. Same-origin in dev via rewrites below, which means this
// project has NO CORS configuration anywhere and AbortController semantics are
// identical in dev and prod.
const API = process.env.NEXT_PUBLIC_API_ORIGIN ?? "http://127.0.0.1:8000";

const nextConfig: NextConfig = {
  async rewrites() {
    return [
      { source: "/api/:path*", destination: `${API}/api/:path*` },
      { source: "/tiles/:path*", destination: `${API}/tiles/:path*` },
      // OGC WMS and OPeNDAP are served by xpublish, mounted under /standards.
      // Exposed at friendly top-level paths so the compliance claim is easy to
      // check: /wms?service=WMS&request=GetCapabilities
      { source: "/wms", destination: `${API}/standards/datasets/ocean/wms` },
      { source: "/opendap:suffix", destination: `${API}/standards/datasets/ocean/opendap:suffix` },
      { source: "/standards/:path*", destination: `${API}/standards/:path*` },
    ];
  },
};

export default nextConfig;
