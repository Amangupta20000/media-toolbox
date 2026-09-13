const nextConfig = {
  output: "standalone",
  outputFileTracingExcludes: {
    "*": ["./data/**/*"],
  },
  // The PDF.js worker is read by the Pages API route at runtime. Next.js
  // cannot infer this file from require.resolve(), so include it explicitly
  // in standalone/Vercel deployments or the route returns a 500 response.
  outputFileTracingIncludes: {
    "/api/pdf/worker": ["./node_modules/pdfjs-dist/legacy/build/pdf.worker.min.mjs"],
  },
  experimental: {
    middlewareClientMaxBodySize: "2gb",
  },
};

export default nextConfig;
