// Source entry (phase 0 fallback + phase 3 composition root).
// The original App component source was lost; its preserved production chunk
// is imported here through the same React instance bridge used by all other
// reconstructed components. Phase 3 features are composed as real TSX around
// the App boundary without modifying the compiled chunk.
import React from "react";
import ReactDOM from "react-dom/client";
import "./vendor/index-DQQUtUzE.css";
import { bJ as AppModule } from "./vendor/App-D3avBeWb.js";

const App = (AppModule as unknown as { default: React.ComponentType }).default;

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
