// Phase 0 bridge: expose the React instance bundled inside the preserved Vite
// entry chunk so reconstructed TSX components share hooks state with the
// vendor chunks. Without this, importing npm "react" creates a second React
// and every hook throws "Cannot read properties of null (reading 'useContext')".
import { __dbStudioReactHooks as React } from "./vendor/index-CLh2VPBN.js";

export const {
  useState,
  useEffect,
  useMemo,
  useRef,
  useCallback,
  useContext,
  useReducer,
  useImperativeHandle,
  useLayoutEffect,
  createElement,
  cloneElement,
  isValidElement,
  forwardRef,
  memo,
  Fragment,
  StrictMode,
  Suspense,
  lazy,
  createContext,
  Children,
  useInsertionEffect,
  useTransition,
  useDeferredValue,
  useSyncExternalStore,
  useActionState,
  useOptimistic,
  startTransition,
  cache,
  act,
  untracked,
  getFragmentOwnership,
  Component,
  PureComponent,
  Profiler,
  createFactory,
  useId,
  createRef,
  useDebugValue,
} = React as any;

export const version: string = (React as any).version ?? "19.3.1";

export default React as any;
