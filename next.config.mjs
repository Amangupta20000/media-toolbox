const nextConfig = {
  output: "standalone",
  outputFileTracingExcludes: {
    "*": ["./data/**/*"],
  },
  experimental: {
    middlewareClientMaxBodySize: "3gb",
  },
};

export default nextConfig;
