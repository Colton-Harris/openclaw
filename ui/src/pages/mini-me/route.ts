import type { RouteLocation } from "@openclaw/uirouter";
import { definePage } from "@openclaw/uirouter";
import { routePageSpec } from "../../app-route-paths.ts";
import type { ApplicationContext } from "../../app/context.ts";
export const page = definePage({
  ...routePageSpec("mini-me"),
  loaderDeps: (_context: ApplicationContext, location: RouteLocation) => location.search,
  loader: (_context: ApplicationContext, { location }) => ({
    setup: new URLSearchParams(location.search).get("setup") === "1",
  }),
  component: () => import("./mini-me-page.ts"),
});
