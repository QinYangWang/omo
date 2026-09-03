"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

let registered = false;
let quotasPromise;
const bearerPrefix = /^Bearer\s+/i;

function loadQuotas() {
  if (!registered) {
    require("tsx/esm/api").register();
    registered = true;
  }
  const packageFile = require.resolve("@latentminds/pi-quotas/package.json");
  const source = path.join(
    path.dirname(packageFile),
    "src",
    "lib",
    "quotas.ts"
  );
  quotasPromise ||= import(pathToFileURL(source).href);
  return quotasPromise;
}

async function fetchQuotas(piService, agentDir, force = false) {
  const quotas = await loadQuotas();
  let stored = {};
  try {
    stored = JSON.parse(
      fs.readFileSync(path.join(agentDir, "auth.json"), "utf8")
    );
  } catch {
    stored = {};
  }
  const runtime = await piService.runtime();
  const authStorage = {
    get: (provider) => stored[provider],
    getApiKey: async (provider) => {
      const credential = stored[provider];
      if (credential?.type === "api_key" && credential.key) {
        return credential.key;
      }
      const auth = (await runtime.getAuth(provider).catch(() => undefined))
        ?.auth;
      const authorization = auth?.headers?.Authorization;
      return auth?.apiKey ?? authorization?.replace(bearerPrefix, "");
    },
  };
  const results = await quotas.fetchAllProviderQuotas(authStorage, { force });
  return {
    installed: true,
    items: results.map(({ provider, result }) => ({
      error: result.success ? undefined : result.error,
      label: quotas.PROVIDER_LABELS[provider],
      provider,
      success: result.success,
      windows: result.success
        ? result.data.windows.map((window) => ({
            ...window,
            resetsAt: new Date(window.resetsAt).toISOString(),
          }))
        : [],
    })),
  };
}

module.exports = { fetchQuotas };
