// Bridges the compiled SQL shell to the shared Workbench component styles.
// It only ADDS class names to existing compiled DOM nodes; it never moves,
// replaces or removes nodes, so React reconciliation and all E2E selectors
// stay intact. The visual contract then comes from workbench.css (the same
// file WbToolbar / WbDataTable / WbStatusBar consume).
import { useEffect } from "react";
import ReactDOM from "react-dom/client";

const ADOPTIONS: Array<[string, string]> = [
  [".statusbar", "wb-statusbar"],
  [".panel-toolbar", "wb-toolbar"],
  [".results-toolbar", "wb-toolbar"],
  [".query-table", "wb-table"],
  [".query-workspace", "wb-app"],
];

function Bridge() {
  useEffect(() => {
    let disposed = false;
    const apply = () => {
      if (disposed) return;
      for (const [selector, sharedClass] of ADOPTIONS) {
        document.querySelectorAll(selector).forEach((element) => {
          if (!element.classList.contains(sharedClass)) element.classList.add(sharedClass);
        });
      }
    };
    apply();
    const observer = new MutationObserver(apply);
    observer.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ["class"] });
    return () => { disposed = true; observer.disconnect(); };
  }, []);
  return null;
}

export function mountCompiledWorkbenchBridge(): void {
  const host = document.createElement("div");
  host.id = "compiled-wb-bridge-root";
  host.style.display = "none";
  document.body.appendChild(host);
  ReactDOM.createRoot(host).render(<Bridge />);
}
