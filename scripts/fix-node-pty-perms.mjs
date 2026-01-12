import fs from "node:fs";
import path from "node:path";

const platform = process.platform;
if (platform !== "darwin") {
  process.exit(0);
}

const arch = process.arch;
const roots = [process.cwd(), path.join(process.cwd(), "server")];
for (const root of roots) {
  const helperPath = path.join(
    root,
    "node_modules",
    "node-pty",
    "prebuilds",
    `${platform}-${arch}`,
    "spawn-helper",
  );

  if (!fs.existsSync(helperPath)) {
    continue;
  }

  try {
    const st = fs.statSync(helperPath);
    const mode = st.mode;
    const hasAnyExec = (mode & 0o111) !== 0;
    if (!hasAnyExec) {
      fs.chmodSync(helperPath, 0o755);
    }
  } catch {
    // Ignore; PTY will surface errors at runtime.
  }
}
