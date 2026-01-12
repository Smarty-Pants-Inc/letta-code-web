import { spawn } from "node:child_process";
import path from "node:path";

const repoRoot = process.cwd();
const lettaCodeDir = path.join(repoRoot, "forks", "letta-code");

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
