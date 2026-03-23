// Global test setup
// Suppress console.log/warn/error noise in tests unless DEBUG=true
if (process.env.DEBUG !== "true") {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
}
