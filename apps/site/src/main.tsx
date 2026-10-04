import { RouterProvider } from "@tanstack/react-router";
import { StrictMode } from "react";
import { createRoot, hydrateRoot } from "react-dom/client";
import { createAppRouter } from "@/router";
// Both faces are named in the --font-sans/--font-heading stacks (tokens.css);
// without these imports the stacks would silently fall through to system fonts.
import "@fontsource-variable/geist";
import "@fontsource-variable/noto-sans-arabic";
import "@/styles/tokens.css";
import "@/styles/prose.css";

const router = createAppRouter();

// During prerender builds we hydrate the static HTML emitted by scripts/build.mjs.
// In dev (`vite`) the shell is empty, so createRoot is the fallback.
async function bootstrap() {
  const rootEl = document.getElementById("root");
  if (!rootEl) return;

  // Load route data and lazy route chunks before hydrating a prerendered page.
  // Otherwise a direct docs URL can briefly replace its complete article HTML
  // with the router's pending state and trigger a hydration mismatch.
  await router.load();

  const app = (
    <StrictMode>
      <RouterProvider router={router} />
    </StrictMode>
  );

  if (rootEl.childElementCount > 0) {
    // The SSG shell is rendered with TanStack's server-safe fragment. Mark
    // this router as the matching SSR client before React claims the shell;
    // the site intentionally does not serialize a full TanStack router state.
    router.ssr = { manifest: undefined };
    hydrateRoot(rootEl, app);
  } else {
    createRoot(rootEl).render(app);
  }
}

void bootstrap();
