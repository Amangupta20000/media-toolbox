import { startLicenseServer } from "./server.js";

startLicenseServer().catch((error) => {
  console.error("Media Toolbox licensing server failed to start:", error);
  process.exitCode = 1;
});
