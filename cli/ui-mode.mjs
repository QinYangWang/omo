import { selectTransportMode } from "./local-host.mjs";

/**
 * UI mode selection for `omo`.
 *
 * The native Pi TUI can only front the local daemon (design §2), so every
 * explicit remote selector keeps the legacy omo TUI, and so does a remote Host
 * selected in the client registry (see `selectUiMode`). The selection is a
 * pure function of the parsed options plus the environment and an injected
 * registry fact so it can be unit tested without a daemon, a TTY or a model
 * call.
 */
export const UI_MODE = {
  legacy: "legacy",
  native: "native",
};

export const OMO_TUI_ENV = "OMO_TUI";

export const NATIVE_LOCAL_ONLY_ERROR =
  "`omo --native` only supports the local omo daemon. Remove --url/--socket/--server (or the OMO_URL/OMO_LOCAL_SOCKET environment overrides) to launch the native Pi TUI.";

export const NATIVE_LEGACY_CONFLICT_ERROR =
  "`omo --native` and `omo --legacy-tui` select different local TUIs. Pass exactly one of them.";

/**
 * Reads the `OMO_TUI` escape hatch. Unset/blank means "no preference"; any
 * other value must be one of the two UI modes so a typo cannot silently pick a
 * TUI. Returns null when the variable is not set.
 */
function selectEnvUiMode(env) {
  const raw = env?.[OMO_TUI_ENV];
  const value = typeof raw === "string" ? raw.trim() : "";
  if (value.length === 0) {
    return null;
  }
  if (value !== UI_MODE.native && value !== UI_MODE.legacy) {
    throw new Error(
      `Invalid ${OMO_TUI_ENV} value ${JSON.stringify(raw)}: expected "native" or "legacy". Leave ${OMO_TUI_ENV} unset to use the local default (native).`
    );
  }
  return value;
}

/**
 * Resolves which TUI `omo` should launch, highest precedence first:
 *
 * 1. Explicit remote selectors (`--server`/`--url`/`--socket` or their env
 *    equivalents) use the legacy omo TUI; combining them with `--native` is a
 *    hard error.
 * 2. `--native` selects the local native Pi TUI.
 * 3. `--legacy-tui` selects the local legacy omo TUI.
 * 4. `OMO_TUI=native|legacy` picks the local mode; explicit flags beat it.
 * 5. A registry-selected remote Host keeps the legacy omo TUI so an explicit
 *    `omo host use <entry>` is not bypassed by the local default.
 * 6. Default local discovery/auto-start uses the native Pi TUI.
 *
 * `context.selectedRegistryHostIsRemote` is injected by the caller because
 * resolving it reads the client Host registry; the function itself stays pure.
 */
export function selectUiMode(options, env = process.env, context = {}) {
  const transport = selectTransportMode(options);
  const wantsNative = options.native === true;
  const wantsLegacy = options.legacyTui === true;
  if (wantsNative && transport !== "local") {
    throw new Error(NATIVE_LOCAL_ONLY_ERROR);
  }
  if (wantsNative && wantsLegacy) {
    throw new Error(NATIVE_LEGACY_CONFLICT_ERROR);
  }
  if (transport !== "local") {
    return UI_MODE.legacy;
  }
  if (wantsNative) {
    return UI_MODE.native;
  }
  if (wantsLegacy) {
    return UI_MODE.legacy;
  }
  const envMode = selectEnvUiMode(env);
  if (envMode !== null) {
    return envMode;
  }
  return context.selectedRegistryHostIsRemote?.() === true
    ? UI_MODE.legacy
    : UI_MODE.native;
}
