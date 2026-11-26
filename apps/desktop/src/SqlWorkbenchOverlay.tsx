// Mounts the source-ized SQL workspace over the compiled .query-workspace.
// Only hides the compiled node (never moves/injects into React's tree), so the
// compiled App keeps its state and all E2E selectors on the new page are ours.
import { useEffect, useState } from "react";
import ReactDOM from "react-dom/client";
import SqlWorkbenchPage from "./SqlWorkbenchPage";

function Overlay() {
  const [active, setActive] = useState(false);

  useEffect(() => {
    let disposed = false;
    const evaluate = () => {
      if (disposed) return;
      const otherPage = document.body.classList.contains("gis-page-active")
        || document.body.classList.contains("mongo-page-active");
      const sqlButton = Array.from(document.querySelectorAll(".workspace-head button"))
        .find((b) => (b.textContent ?? "").includes("SQL"));
      const isSqlActive = !!sqlButton && sqlButton.className.includes("primary");
      const shouldShow = !otherPage && isSqlActive;
      setActive(shouldShow);
      document.body.classList.toggle("sql-wb-active", shouldShow);
    };
    evaluate();
    const observer = new MutationObserver(evaluate);
    observer.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ["class"] });
    return () => { disposed = true; observer.disconnect(); };
  }, []);

  if (!active) return null;
  return <SqlWorkbenchPage />;
}

export function mountSqlWorkbenchOverlay(): void {
  const host = document.createElement("div");
  host.id = "sql-wb-overlay-root";
  document.body.appendChild(host);
  ReactDOM.createRoot(host).render(<Overlay />);
}
