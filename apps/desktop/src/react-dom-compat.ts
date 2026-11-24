// react-dom bridge backed by the vendor-bundled ReactDOM instance.
import { __dbStudioReactDom as ReactDOM } from "./vendor/index-CLh2VPBN.js";

const D = ReactDOM as any;
export const createRoot = D.createRoot;
export const hydrateRoot = D.hydrateRoot;
export const render = D.render;
export const unmountComponentAtNode = D.unmountComponentAtNode;
export const unstable_batchedUpdates = D.unstable_batchedUpdates;
export const createPortal = D.createPortal;
export const flushSync = D.flushSync;
export const version = D.version;
export default D;
