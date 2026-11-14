// apps/settings/src/shell/ErrorBoundary.tsx
//
// Wave 63 — reusable error boundary with a Retry button. MainShell
// wraps every module route and the persistent viewer layer in one, so
// a crash in one module shows a readable error instead of unmounting
// the whole app (white screen).
//
// `resetKey`: when it changes (e.g. the route pathname) a tripped
// boundary resets itself, so navigating away from a broken module
// recovers without a reload.

import { Component, type ErrorInfo, type ReactNode } from "react";
import { createPortal } from "react-dom";

export interface ErrorBoundaryProps {
  children: ReactNode;
  /** Short name of what is wrapped, shown in the message ("Documents"). */
  label?: string;
  /** Changing this resets a tripped boundary. */
  resetKey?: unknown;
  /**
   * Wave 64 — render the fallback into this node (via a portal) instead
   * of in place. Used by the persistent 3D surface, whose normal output
   * is itself portaled into the active route's viewport.
   */
  fallbackContainer?: HTMLElement | null;
}

interface ErrorBoundaryState {
  error: Error | null;
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: unknown): ErrorBoundaryState {
    return { error: error instanceof Error ? error : new Error(String(error)) };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // eslint-disable-next-line no-console
    console.error(`[ErrorBoundary${this.props.label ? `:${this.props.label}` : ""}]`, error, info.componentStack);
  }

  componentDidUpdate(prev: ErrorBoundaryProps): void {
    if (this.state.error && prev.resetKey !== this.props.resetKey) {
      this.setState({ error: null });
    }
  }

  private retry = (): void => {
    this.setState({ error: null });
  };

  render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;
    const what = this.props.label ?? "This part of FreeField";
    const fallback = (
      <div
        role="alert"
        data-testid="error-boundary"
        style={{
          flex: 1,
          minHeight: 0,
          display: "flex",
          flexDirection: "column",
          alignItems: "flex-start",
          gap: 8,
          padding: 24,
          maxWidth: 560,
          fontFamily: "var(--ff-font-stack)",
          color: "var(--ff-text-primary)",
        }}
      >
        <h2 style={{ fontSize: 18, margin: 0 }}>{what} ran into a problem</h2>
        <p style={{ margin: 0, color: "var(--ff-text-secondary)", fontSize: 13 }}>
          {error.message || "Unknown error"}
        </p>
        <button
          type="button"
          data-testid="error-boundary-retry"
          onClick={this.retry}
          style={{
            height: 32,
            padding: "0 14px",
            borderRadius: 6,
            border: "1px solid var(--ff-border)",
            background: "var(--ff-bg-app)",
            color: "var(--ff-text-primary)",
            cursor: "pointer",
            fontFamily: "inherit",
          }}
        >
          Retry
        </button>
      </div>
    );
    const container = this.props.fallbackContainer;
    return container ? createPortal(fallback, container) : fallback;
  }
}

export default ErrorBoundary;
