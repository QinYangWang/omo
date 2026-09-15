import {
  Component,
  type ErrorInfo,
  lazy,
  type ReactNode,
  StrictMode,
  Suspense,
  useEffect,
  useState,
} from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import App from "./App";
import { DaemonPairingGate } from "./components/DaemonPairingGate";
import { OnboardingGate } from "./components/OnboardingGate";
import { ToastProvider } from "./components/ui/toast";
import { I18nProvider } from "./lib/i18n";
import { getDaemonClient } from "./lib/omo-v2";
import {
  initializeServers,
  listServers,
  needsOnboarding,
  setLocalServerToken,
} from "./lib/servers";
import { ThemeProvider } from "./lib/theme";
import { installWebPreviewApi } from "./lib/web-preview";

const DaemonSessionsView = lazy(() =>
  import("./components/DaemonSessionsView").then(
    ({ DaemonSessionsView: LoadedDaemonSessionsView }) => ({
      default: LoadedDaemonSessionsView,
    })
  )
);

class ErrorBoundary extends Component<
  { children: ReactNode },
  { error?: Error }
> {
  state: { error?: Error } = {};

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("Renderer crashed", error, info.componentStack);
  }

  render() {
    if (this.state.error) {
      return (
        <main className="flex h-screen items-center justify-center bg-background p-8 text-foreground">
          <div className="max-w-xl rounded-xl border border-red-500/20 bg-card p-5">
            <h1 className="font-medium text-red-400">Renderer error</h1>
            <pre className="mt-3 whitespace-pre-wrap text-muted-foreground text-sm">
              {this.state.error.stack || this.state.error.message}
            </pre>
          </div>
        </main>
      );
    }
    return this.props.children;
  }
}

function DaemonHostedRoot({ webMode }: { webMode: "v1" | "v2" }) {
  const [paired, setPaired] = useState<boolean | null>(null);

  useEffect(() => {
    getDaemonClient()
      .then(async (handle) => {
        if (handle && webMode === "v1") {
          await setLocalServerToken(handle.config.token);
        }
        setPaired(Boolean(handle));
      })
      .catch(() => setPaired(false));
  }, [webMode]);

  if (paired === null) {
    return null;
  }
  if (!paired) {
    return <DaemonPairingGate onDone={() => setPaired(true)} />;
  }
  if (webMode === "v1") {
    return <App />;
  }
  return (
    <Suspense fallback={null}>
      <DaemonSessionsView />
    </Suspense>
  );
}

function Root({
  daemonHosted,
  daemonWebMode,
  gatedInitially,
}: {
  daemonHosted: boolean;
  daemonWebMode: "v1" | "v2";
  gatedInitially: boolean;
}) {
  const [gated, setGated] = useState(gatedInitially);
  if (daemonHosted) {
    return <DaemonHostedRoot webMode={daemonWebMode} />;
  }
  if (gated) {
    return <OnboardingGate onDone={() => setGated(false)} />;
  }
  return <App />;
}

async function bootstrap() {
  await initializeServers();
  const daemonHosted = Boolean(window.__OMO_DAEMON_URL__);
  const daemonWebMode = window.__OMO_DAEMON_WEB_MODE__ ?? "v2";
  const gated = daemonHosted ? false : await needsOnboarding();
  if (!(daemonHosted || gated) && listServers().length === 0) {
    // Pure static web without any configured remote server.
    installWebPreviewApi();
  }
  const root = document.getElementById("root");
  if (!root) {
    throw new Error("Root element is missing");
  }
  createRoot(root).render(
    <StrictMode>
      <ErrorBoundary>
        <ThemeProvider>
          <I18nProvider>
            <ToastProvider>
              <Root
                daemonHosted={daemonHosted}
                daemonWebMode={daemonWebMode}
                gatedInitially={gated}
              />
            </ToastProvider>
          </I18nProvider>
        </ThemeProvider>
      </ErrorBoundary>
    </StrictMode>
  );
}

bootstrap()
  .catch((error: unknown) => {
    console.error("Failed to bootstrap renderer", error);
  })
  .finally(() => {
    // Never leave the startup canvas above the app when an async bootstrap
    // step fails (for example, blocked localStorage in a private browser).
    (window as { omoSplashDone?: () => void }).omoSplashDone?.();
  });
