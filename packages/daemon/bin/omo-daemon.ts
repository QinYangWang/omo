#!/usr/bin/env node
import { readFileSync } from "node:fs";
import type { Api, Model, Models } from "@earendil-works/pi-ai";
/**
 * omo daemon entry (plan §13 P1).
 *
 *   node --no-warnings packages/daemon/bin/omo-daemon.ts \
 *     --data-dir <dir> [--host 127.0.0.1] [--port 5190] --faux
 *
 * `--faux` wires the upstream faux provider (one canned response is queued
 * for smoke testing; append more through the package API). Real provider
 * credentials are resolved by the execution-side pi auth store; the daemon
 * refuses to start without --faux or an explicit provider/model rather than
 * silently running without models.
 */
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { createFauxModels } from "@omo/agent-runtime/testing";
import { openDaemon } from "../src/daemon.ts";
import { DaemonHttpServer } from "../src/http.ts";
import { createProviderModels } from "../src/providers.ts";
import { createCoreDaemonRuntime } from "../src/runtime.ts";

interface Args {
  authPath?: string;
  dataDir?: string;
  faux: boolean;
  host: string;
  maxWorkers?: number;
  model?: string;
  pairingCode?: string;
  port: number;
  provider?: string;
  tlsCert?: string;
  tlsKey?: string;
  webMode: "v1" | "v2";
  webRoot?: string;
  workspaceRoots: string[];
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: CLI flags are intentionally parsed in one pass
const parseArgs = (argv: string[]): Args => {
  const args: Args = {
    faux: false,
    host: "127.0.0.1",
    port: 5190,
    webMode: "v2",
    workspaceRoots: [],
  };
  const takeValue = (index: number, flag: string): [string, number] => {
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`missing value for ${flag}`);
    }
    return [value, index + 1];
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--faux") {
      args.faux = true;
      continue;
    }
    let value: string | undefined;
    if (
      arg === "--data-dir" ||
      arg === "--host" ||
      arg === "--port" ||
      arg === "--max-workers" ||
      arg === "--pairing-code" ||
      arg === "--workspace-root" ||
      arg === "--provider" ||
      arg === "--model" ||
      arg === "--auth-path" ||
      arg === "--tls-cert" ||
      arg === "--tls-key" ||
      arg === "--web-root" ||
      arg === "--web-mode"
    ) {
      [value, index] = takeValue(index, arg);
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
    if (arg === "--data-dir") {
      args.dataDir = value;
    } else if (arg === "--host") {
      args.host = value;
    } else if (arg === "--port") {
      args.port = Number(value);
    } else if (arg === "--max-workers") {
      args.maxWorkers = Number(value);
    } else if (arg === "--pairing-code") {
      args.pairingCode = value;
    } else if (arg === "--workspace-root") {
      args.workspaceRoots.push(value);
    } else if (arg === "--provider") {
      args.provider = value;
    } else if (arg === "--model") {
      args.model = value;
    } else if (arg === "--auth-path") {
      args.authPath = value;
    } else if (arg === "--tls-cert") {
      args.tlsCert = value;
    } else if (arg === "--tls-key") {
      args.tlsKey = value;
    } else if (arg === "--web-root") {
      args.webRoot = value;
    } else if (arg === "--web-mode") {
      if (value !== "v1" && value !== "v2") {
        throw new Error(`invalid --web-mode: ${value} (use v1 or v2)`);
      }
      args.webMode = value;
    }
  }
  return args;
};

const main = async (): Promise<void> => {
  const args = parseArgs(process.argv.slice(2));
  const dataDir =
    args.dataDir ?? process.env.OMO_DAEMON_DATA_DIR ?? ".omo-daemon";
  const provider = args.provider ?? process.env.OMO_DAEMON_PROVIDER;
  const modelId = args.model ?? process.env.OMO_DAEMON_MODEL;
  const authPath = args.authPath ?? process.env.OMO_DAEMON_AUTH_PATH;

  let model: Model<Api>;
  let models: Models;
  if (args.faux) {
    const fauxKit = createFauxModels();
    fauxKit.faux.setResponses([
      fauxAssistantMessage("omo daemon (faux) is running"),
    ]);
    ({ model, models } = fauxKit);
  } else if (provider && modelId) {
    ({ model, models } = await createProviderModels({
      authPath,
      modelId,
      providerId: provider,
    }));
  } else {
    throw new Error(
      "the daemon requires either --faux (smoke) or --provider <id> --model <id> " +
        "(real providers via the pi auth store, plan §10.1)"
    );
  }

  const runtime = createCoreDaemonRuntime({ dataDir, model, models });
  const daemon = openDaemon({
    dataDir,
    maxWorkers: args.maxWorkers,
    pairingCode: args.pairingCode,
    runtime,
    workspaceRoots:
      args.workspaceRoots.length > 0 ? args.workspaceRoots : undefined,
  });
  const tlsCert = args.tlsCert ?? process.env.OMO_DAEMON_TLS_CERT;
  const tlsKey = args.tlsKey ?? process.env.OMO_DAEMON_TLS_KEY;
  if (args.host !== "127.0.0.1" && args.host !== "localhost" && !tlsCert) {
    console.error(
      "warning: binding a non-loopback host without TLS (plan §4.2); " +
        "set --tls-cert/--tls-key or OMO_DAEMON_TLS_CERT/KEY"
    );
  }
  const webRoot = args.webRoot ?? process.env.OMO_WEB_ROOT;
  const http = new DaemonHttpServer(daemon, {
    tls:
      tlsCert && tlsKey
        ? {
            cert: readFileSync(tlsCert, "utf8"),
            key: readFileSync(tlsKey, "utf8"),
          }
        : undefined,
    webMode: args.webMode,
    webRoot,
  });
  const listening = await http.listen(args.port, args.host);

  console.log(
    JSON.stringify({
      durability: daemon.durability,
      listening,
      pairingCodeFile: `${dataDir}/pairing-code`,
      serverId: daemon.identity.serverId,
    })
  );

  const shutdown = async (signal: string): Promise<void> => {
    console.error(`received ${signal}, closing daemon`);
    await http.close();
    await daemon.close();
    process.exit(0);
  };
  const onSignal = (signal: string): void => {
    shutdown(signal).catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    });
  };
  process.on("SIGINT", () => onSignal("SIGINT"));
  process.on("SIGTERM", () => onSignal("SIGTERM"));
};

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
