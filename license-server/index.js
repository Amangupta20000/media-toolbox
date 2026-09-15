import { startLicenseServer } from "./server.js";

startLicenseServer().catch((error) => {
  console.error("NativeMedia Agent licensing server failed to start:", error);
  process.exitCode = 1;
});
