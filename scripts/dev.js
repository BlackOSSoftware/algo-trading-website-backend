const { spawn } = require("child_process");

const children = [];

function run(cmd, args) {
  const child = spawn(cmd, args, { stdio: "inherit", shell: true });
  children.push(child);
  child.on("exit", (code, signal) => {
    if (signal) {
      shutdown();
      process.exit(1);
    }
    if (code && code !== 0) {
      shutdown();
      process.exit(code);
    }
  });
  return child;
}

function shutdown() {
  for (const child of children) {
    if (child && !child.killed) child.kill("SIGTERM");
  }
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

run("npm", ["--prefix", "frontend", "run", "dev"]);
run("node", ["backend/index.js"]);
