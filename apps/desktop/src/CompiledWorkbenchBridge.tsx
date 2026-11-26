// Bridges the compiled SQL shell to the shared Workbench components.
// Only ADDs shared class names to compiled DOM nodes (never moves/replaces
// nodes), and renders a real WbStatusBar that replaces the compiled statusbar
// visually. E2E selectors on compiled chrome remain untouched.
import { useEffect, useState } from "react";
import ReactDOM from "react-dom/client";
import { WbStatusBar } from "./workbench/Workbench";

const ADOPTIONS: Array<[string, string]> = [
  [".statusbar", "wb-statusbar"],
  [".query-table", "wb-table"],
  [".query-workspace", "wb-app"],
  [".document-tab", "wb-tab-container"],
  [".panel-toolbar .ant-btn", "wb-tool-btn"],
  [".results-toolbar .ant-btn", "wb-tool-btn"],
  [".head-actions .ant-btn", "wb-tool-btn"],
];

function Bridge() {
  const [sqlActive, setSqlActive] = useState(false);
  const [status, setStatus] = useState("就绪");

  useEffect(() => {
    let disposed = false;
    const apply = () => {
      if (disposed) return;
      for (const [selector, sharedClass] of ADOPTIONS) {
        document.querySelectorAll(selector).forEach((element) => {
          if (!element.classList.contains(sharedClass)) element.classList.add(sharedClass);
        });
      }
      const isSql = !!document.querySelector(".query-workspace");
      setSqlActive(isSql);
      // Place the source-ized object tree directly below the compiled
      // connection list, so both live in one left sidebar (vertical stack).
      const connectionList = document.querySelector(".shell .sidebar .connection-list");
      if (connectionList && isSql) {
        const bottom = Math.ceil(connectionList.getBoundingClientRect().bottom);
        document.documentElement.style.setProperty("--sql-tree-top", `${bottom + 8}px`);
      }
      const state = document.querySelector(".status-left")?.textContent?.trim()
        || document.querySelector(".status-ready")?.textContent?.trim();
      if (state) setStatus(state.slice(0, 80));
    };
    apply();
    const observer = new MutationObserver(apply);
    observer.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ["class"] });
    return () => { disposed = true; observer.disconnect(); };
  }, []);

  if (!sqlActive) return null;
  return <div className="compiled-wb-statusbar"><WbStatusBar left={status} right="SQL 编辑器" /></div>;
}

export function mountCompiledWorkbenchBridge(): void {
  const host = document.createElement("div");
  host.id = "compiled-wb-bridge-root";
  document.body.appendChild(host);
  ReactDOM.createRoot(host).render(<Bridge />);
}
