import fs from "node:fs/promises";
import path from "node:path";
import selfsigned from "selfsigned";

const CERTIFICATE_DAYS = 825;

export async function ensureAgentCertificate(directory) {
  const certificateDirectory = path.resolve(directory);
  const keyPath = path.join(certificateDirectory, "agent-key.pem");
  const certPath = path.join(certificateDirectory, "agent-cert.pem");
  try {
    await fs.access(keyPath);
    await fs.access(certPath);
    return { keyPath, certPath, created: false };
  } catch {
    // Generate the certificate on first launch so every installation gets its
    // own private key. It is used only for the loopback HTTPS endpoint.
  }

  await fs.mkdir(certificateDirectory, { recursive: true, mode: 0o700 });
  const attributes = [{ name: "commonName", value: "localhost" }];
  const extensions = [{
    name: "subjectAltName",
    altNames: [
      { type: 2, value: "localhost" },
      { type: 7, ip: "127.0.0.1" },
      { type: 7, ip: "::1" },
    ],
  }];
  const pair = await selfsigned.generate(attributes, {
    algorithm: "sha256",
    days: CERTIFICATE_DAYS,
    keySize: 2048,
    extensions,
  });
  await fs.writeFile(keyPath, pair.private, { mode: 0o600 });
  await fs.writeFile(certPath, pair.cert, { mode: 0o644 });
  return { keyPath, certPath, created: true };
}
