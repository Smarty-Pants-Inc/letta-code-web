import { spawn } from "node:child_process";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

async function pickPort() {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  await new Promise((resolve) => server.close(resolve));
  if (!port) throw new Error("Failed to pick a free port");
  return port;
}

const port = await pickPort();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const playwrightBin = path.resolve(__dirname, "../../node_modules/.bin/playwright");

const child = spawn(playwrightBin, ["test"], {
  stdio: "inherit",
  env: {
    ...process.env,
    WEB_TUI_PORT: String(port),
  },
});

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
});
