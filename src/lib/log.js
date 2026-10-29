// stdout is reserved for the MCP protocol. All logging goes to stderr.
// Never pass secrets, request headers, or full page bodies to these functions.
function emit(level, msg, extra) {
  const line = { t: new Date().toISOString(), level, msg, ...extra };
  process.stderr.write(JSON.stringify(line) + "\n");
}

export const log = {
  debug: (msg, extra) => emit("DEBUG", msg, extra),
  info: (msg, extra) => emit("INFO", msg, extra),
  warn: (msg, extra) => emit("WARN", msg, extra),
  error: (msg, extra) => emit("ERROR", msg, extra),
};
