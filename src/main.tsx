import { Component, StrictMode, type ErrorInfo, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import App from "./App";

class ErrorBoundary extends Component<{ children: ReactNode }, { error?: Error }> {
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
            <pre className="mt-3 whitespace-pre-wrap text-sm text-muted-foreground">
              {this.state.error.stack || this.state.error.message}
            </pre>
          </div>
        </main>
      );
    }
    return this.props.children;
  }
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>
);
