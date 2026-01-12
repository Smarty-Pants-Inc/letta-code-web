import { spawn } from "node:child_process";
import path from "node:path";

const workspaceRoot =
  process.env.WORKSPACE_ROOT && process.env.WORKSPACE_ROOT.trim()
    ? path.resolve(process.env.WORKSPACE_ROOT)
    : process.cwd();

const lettaCodeDir =
  process.env.LETTA_CODE_DIR && process.env.LETTA_CODE_DIR.trim()
    ? path.resolve(process.env.LETTA_CODE_DIR)
    : path.join(workspaceRoot, "forks", "letta-code");

const bun = process.env.BUN ?? "bun";
const child = spawn(
  bun,
  [
    "--loader:.md=text",
    "--loader:.mdx=text",
    "--loader:.txt=text",
    "run",
    "src/index.ts",
  ],
  {
    cwd: lettaCodeDir,
    stdio: "inherit",
    env: process.env,
  },
);

process.on("SIGINT", () => child.kill("SIGINT"));
process.on("SIGTERM", () => child.kill("SIGTERM"));

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
});
