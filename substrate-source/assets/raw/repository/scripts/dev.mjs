import { spawn } from "node:child_process";
import process from "node:process";
import { createServer } from "vite";

const host = "127.0.0.1";
const fallbackPort = 5173;

let viteServer = null;
let electronProcess = null;
let shuttingDown = false;

async function closeServers(exitCode = 0) {
  if (shuttingDown) return;
  shuttingDown = true;

  if (electronProcess && !electronProcess.killed) {
    electronProcess.kill();
  }

  if (viteServer) {
    await viteServer.close();
  }

  process.exit(exitCode);
}

process.on("SIGINT", () => {
  void closeServers(0);
});

process.on("SIGTERM", () => {
  void closeServers(0);
});

try {
  viteServer = await createServer({
    server: {
      host,
      port: fallbackPort,
      strictPort: false
    }
  });

  await viteServer.listen();

  const address = viteServer.httpServer?.address();
  const port = typeof address === "object" && address ? address.port : fallbackPort;
  const devServerUrl = `http://${host}:${port}`;

  electronProcess = spawn("electron", ["."], {
    stdio: "inherit",
    shell: process.platform === "win32",
    env: {
      ...process.env,
      VITE_DEV_SERVER_URL: devServerUrl
    }
  });

  electronProcess.on("exit", (exitCode) => {
    void closeServers(exitCode ?? 0);
  });
} catch (error) {
  console.error(error);
  await closeServers(1);
}