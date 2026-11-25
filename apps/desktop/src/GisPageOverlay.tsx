// Mounts the redesigned GIS page as a fixed overlay beside the React tree.
// IMPORTANT: never inject nodes into the compiled App's containers — that
// breaks React reconciliation when the page switches. We only observe the DOM,
// toggle a body class, and render into our own body-level root.
import { useEffect, useState } from "react";
import ReactDOM from "react-dom/client";
import GisExchangePage from "./GisExchangePage";

function Overlay() {
  const [active, setActive] = useState(false);

  useEffect(() => {
    const evaluate = () => {
      const isGis = !!document.querySelector(".gis-workspace");
      setActive(isGis);
      document.body.classList.toggle("gis-page-active", isGis);
    };
    evaluate();
    const observer = new MutationObserver(evaluate);
    observer.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ["class"] });
    return () => observer.disconnect();
  }, []);

  if (!active) return null;
  return <div className="gis-exchange-overlay"><GisExchangePage /></div>;
}

export function mountGisPageOverlay(): void {
  const host = document.createElement("div");
  host.id = "gis-page-overlay-root";
  document.body.appendChild(host);
  ReactDOM.createRoot(host).render(<Overlay />);
}
