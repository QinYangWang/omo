import { Component, type ErrorInfo, type ReactNode, StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import App from "./App";
import { I18nProvider } from "./lib/i18n";
import { getRemoteConfig, initializeRemoteConfig } from "./lib/remote-api";
import { ThemeProvider } from "./lib/theme";
import { installWebPreviewApi } from "./lib/web-preview";

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

async function bootstrap() {
  await initializeRemoteConfig();
  if (!(window.omo || getRemoteConfig().url)) {
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
            <App />
          </I18nProvider>
        </ThemeProvider>
      </ErrorBoundary>
    </StrictMode>
  );
}

bootstrap().catch((error: unknown) => {
  console.error("Failed to bootstrap renderer", error);
});
