// Source composition root (phase 0 fallback + phase 3).
// The preserved Vite entry chunk bootstraps App with its own bundled React
// instance and QueryClientProvider; importing it as a side effect keeps a
// single dispatcher. Phase 3 panels are mounted in a SEPARATE React root so
// they share the app's React instance (via the alias bridge) without nesting
// a second QueryClientProvider around the compiled App.
import "./vendor/index-DQQUtUzE.css";
import "./phase3-launcher.css";
import "./object-tree.css";
import "./design-system.css";
import "./gis-layout-fix.css";
import "./gis-page.css";
import "./mongo-page.css";
import "./db-tools.css";
import "./vendor/index-CLh2VPBN.js";

// Phase3Launcher is loaded lazily after the App chunk has initialised so both
// roots use the same bundled React instance.
void import("./Phase3Launcher").then(({ mountPhase3Launcher }) => mountPhase3Launcher());
void import("./GisPageOverlay").then(({ mountGisPageOverlay }) => mountGisPageOverlay());
