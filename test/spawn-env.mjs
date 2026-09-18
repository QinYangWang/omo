/**
 * Spawned server/CLI processes in tests must be hermetic. A developer shell
 * (or an agent harness) may export OMO_TOKEN / OMO_TLS_* / OMO_HOST /
 * OMO_WORKSPACE_ROOTS for a real daemon, and a plain `...process.env` spread
 * silently leaks them into test servers: TLS turns on so plain-HTTP health
 * probes time out, and a leaked token makes unauthenticated probes fail.
 *
 * Spread this immediately after `...process.env` in every test spawn env;
 * keys the test sets explicitly afterwards still win.
 */
export const scrubOmoEnv = {
  OMO_HOST: "127.0.0.1",
  OMO_TLS_CERT: "",
  OMO_TLS_KEY: "",
  OMO_TOKEN: "",
  OMO_WORKSPACE_ROOTS: "",
};
