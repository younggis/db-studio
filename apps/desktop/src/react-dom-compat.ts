// react-dom bridge backed by the vendor-bundled ReactDOM instances.
// `__dbStudioReactDom` is react-dom/client (createRoot); `__dbStudioReactDomFull`
// is the full react-dom module (createPortal, flushSync, ...).
import {
  __dbStudioReactDom as ReactDOMClient,
  __dbStudioReactDomFull as ReactDOMFull,
} from "./vendor/index-CLh2VPBN.js";

const C = ReactDOMClient as any;
const F = ReactDOMFull as any;
export const createRoot = C.createRoot;
export const hydrateRoot = C.hydrateRoot;
export const createPortal = F.createPortal;
export const flushSync = F.flushSync;
export const render = F.render;
export const unmountComponentAtNode = F.unmountComponentAtNode;
export const unstable_batchedUpdates = F.unstable_batchedUpdates ?? C.unstable_batchedUpdates;
export const version = F.version ?? C.version;
export default { ...F, ...C };
