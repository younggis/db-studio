// Keeps a panel render error from unmounting the whole workbench (which would
// leave the user on a blank page with no way back).
import { Component, type ErrorInfo, type ReactNode } from "react";

export default class PanelErrorBoundary extends Component<
  { children: ReactNode; onReset?: () => void },
  { error?: Error }
> {
  state: { error?: Error } = {};

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("Panel render error", error, info.componentStack);
  }

  render() {
    if (this.state.error) {
      return (
        <div style={{ padding: 16, color: "var(--wb-danger)", fontSize: 12 }}>
          <div>面板加载失败：{this.state.error.message}</div>
          <button
            type="button"
            style={{ marginTop: 8, padding: "4px 10px", cursor: "pointer" }}
            onClick={() => {
              this.setState({ error: undefined });
              this.props.onReset?.();
            }}
          >
            关闭面板
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
