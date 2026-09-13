const nextConfig = {
  output: "standalone",
  outputFileTracingExcludes: {
    "*": ["./data/**/*"],
  },
  // The PDF.js worker is read by the Pages API route at runtime. Include it
  // explicitly in standalone/Vercel deployments so the serverless route can
  // serve the worker without relying on package metadata resolution.
  outputFileTracingIncludes: {
    "/api/pdf/worker": ["./node_modules/pdfjs-dist/legacy/build/pdf.worker.min.mjs"],
  },
  experimental: {
    middlewareClientMaxBodySize: "2gb",
  },
};

export default nextConfig;
