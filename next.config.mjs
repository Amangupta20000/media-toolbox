const nextConfig = {
  output: "standalone",
  outputFileTracingExcludes: {
    "*": ["./data/**/*"],
  },
  experimental: {
    middlewareClientMaxBodySize: "2gb",
  },
};

export default nextConfig;
