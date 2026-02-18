import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { config as loadDotenv } from "dotenv";

loadDotenv({
  path: fileURLToPath(new URL("../.env", import.meta.url)),
  quiet: true,
});

const require = createRequire(import.meta.url);
const mediasoupEntryPath = require.resolve("mediasoup");
const mediasoupDir = path.resolve(path.dirname(mediasoupEntryPath), "..", "..");
const workerReleaseDir = path.join(mediasoupDir, "worker", "out", "Release");

const workerCandidates = [
  path.join(workerReleaseDir, "mediasoup-worker"),
  path.join(workerReleaseDir, "mediasoup-worker.exe"),
];

const hasWorkerBinary = () => workerCandidates.some(filePath => fs.existsSync(filePath));

if (hasWorkerBinary()) {
  process.exit(0);
}

const scriptPath = path.join(mediasoupDir, "npm-scripts.mjs");
const result = spawnSync(process.execPath, [scriptPath, "postinstall"], {
  cwd: mediasoupDir,
  stdio: "inherit",
  env: process.env,
});

if (result.status !== 0) {
  process.exit(result.status ?? 1);
}

if (!hasWorkerBinary()) {
  console.error("mediasoup worker binary is missing after postinstall.");
  process.exit(1);
}
