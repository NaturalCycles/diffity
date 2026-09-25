import { startTransition, StrictMode } from "react";
import { hydrateRoot } from "react-dom/client";
import { HydratedRouter } from "react-router/dom";
import { appBase } from "./lib/base";

declare global {
  interface Window {
    __reactRouterContext?: { basename?: string };
  }
}

// One build serves every hosted review under its own path, so the router's basename is decided
// by the page rather than at build time. With no base the build's own "/" stands.
const base = appBase();
if (base && window.__reactRouterContext) {
  window.__reactRouterContext.basename = base;
}

startTransition(() => {
  hydrateRoot(
    document,
    <StrictMode>
      <HydratedRouter />
    </StrictMode>,
  );
});
