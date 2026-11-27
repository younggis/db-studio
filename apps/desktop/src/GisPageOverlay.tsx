// Render GIS through a portal so it participates in the workspace layout.
import { useEffect, useState } from "react";
import ReactDOM from "react-dom/client";
import { createPortal } from "react-dom";
import GisExchangePage from "./GisExchangePage";

function Overlay() {
  const [workspace, setWorkspace] = useState<Element | null>(null);

  useEffect(() => {
    const evaluate = () => {
      const target = document.querySelector("#root .gis-workspace")?.closest(".workspace") ?? null;
      setWorkspace(target);
      document.body.classList.toggle("gis-page-active", target !== null);
    };
    evaluate();
    const observer = new MutationObserver(evaluate);
    observer.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ["class"] });
    return () => observer.disconnect();
  }, []);

  return workspace && createPortal(<div className="gis-exchange-overlay"><GisExchangePage /></div>, workspace);
}

export function mountGisPageOverlay(): void {
  const host = document.createElement("div");
  host.id = "gis-page-overlay-root";
  document.body.appendChild(host);
  ReactDOM.createRoot(host).render(<Overlay />);
}
