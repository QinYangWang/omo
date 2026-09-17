import { selectTransportMode } from "./local-host.mjs";

/**
 * UI mode selection for `omo`.
 *
 * The native Pi TUI can only front the local daemon (design §2), so every
 * explicit remote selector keeps the legacy omo TUI. A remote Host selected in
 * the client registry keeps it too, so an explicit `omo host use <entry>` is
 * not bypassed by the local default. The selection is a pure function of the
 * parsed options plus an injected registry fact so it can be unit tested
 * without a daemon, a TTY or a model call.
 */
export const UI_MODE = {
  legacy: "legacy",
  native: "native",
};

export const NATIVE_LOCAL_ONLY_ERROR =
  "`omo --native` only supports the local omo daemon. Remove --url/--socket/--server (or the OMO_URL/OMO_LOCAL_SOCKET environment overrides) to launch the native Pi TUI.";

/**
 * Resolves which TUI `omo` should launch.
 *
 * 1. Explicit remote selectors (`--server`/`--url`/`--socket` or their env
 *    equivalents) always use the legacy omo TUI.
 * 2. `--native` forces the native Pi TUI and rejects remote selectors.
 * 3. A registry-selected remote Host keeps the legacy omo TUI.
 * 4. Default local discovery/auto-start uses the native Pi TUI.
 *
 * `context.selectedRegistryHostIsRemote` is injected by the caller because
 * resolving it reads the client Host registry; the function itself stays pure.
 */
export function selectUiMode(options, context = {}) {
  const transport = selectTransportMode(options);
  if (options.native === true && transport !== "local") {
    throw new Error(NATIVE_LOCAL_ONLY_ERROR);
  }
  if (transport !== "local") {
    return UI_MODE.legacy;
  }
  if (options.native === true) {
    return UI_MODE.native;
  }
  return context.selectedRegistryHostIsRemote?.() === true
    ? UI_MODE.legacy
    : UI_MODE.native;
}
