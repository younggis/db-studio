// JSX automatic-runtime bridge backed by the vendor-bundled React instance.
import { __dbStudioReactHooks as React } from "./vendor/index-CLh2VPBN.js";

const R = React as any;

export const jsx = (type: any, props: any, key?: any) =>
  R.createElement(type, key === undefined ? props : { ...props, key });
export const jsxs = jsx;
export const jsxDEV = jsx;
export const Fragment = R.Fragment;
