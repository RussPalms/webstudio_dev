import { lazy } from "react";
import { useLoaderData, type MetaFunction } from "@remix-run/react";
import { json, type LoaderFunctionArgs } from "@remix-run/server-runtime";
import { dashboardProjectRouter } from "@webstudio-is/dashboard/index.server";
import { findAuthenticatedUser } from "~/services/auth.server";
import { builderUrl, isDashboard, loginPath } from "~/shared/router-utils";
import { createContext } from "~/shared/context.server";
import env from "~/env/env.server";
import { ClientOnly } from "~/shared/client-only";
import { preventCrossOriginCookie } from "~/services/no-cross-origin-cookie";
import { createCallerFactory } from "@webstudio-is/trpc-interface/index.server";
import { redirect } from "~/services/no-store-redirect";
import { preconnect, prefetchDNS } from "react-dom";
import { parseBuilderUrl } from "@webstudio-is/http-client";
import { allowedDestinations } from "~/services/destinations.server";

const dashboardProjectCaller = createCallerFactory(dashboardProjectRouter);

export const meta: MetaFunction<typeof loader> = () => {
  const metas: ReturnType<MetaFunction> = [];

  metas.push({ title: "Webstudio Dashboard" });

  return metas;
};

export const loader = async ({ request }: LoaderFunctionArgs) => {
  if (false === isDashboard(request)) {
    throw new Response(null, {
      status: 404,
      statusText: "Not Found",
    });
  }

  preventCrossOriginCookie(request);
  allowedDestinations(request, ["document", "empty"]);
  // CSRF token checks are not necessary for dashboard-only pages.
  // All requests from the builder or canvas app are safeguarded either by preventCrossOriginCookie for fetch requests
  // or by allowedDestinations for iframe requests.

  const user = await findAuthenticatedUser(request);

  if (user === null) {
    const url = new URL(request.url);
    throw redirect(
      loginPath({
        returnTo: url.pathname,
      })
    );
  }

  const context = await createContext(request);

  const projects = await dashboardProjectCaller(context).findMany({
    userId: user.id,
  });

  const projectTemplates = await dashboardProjectCaller(context).findManyByIds({
    projectIds: env.PROJECT_TEMPLATES,
  });

  const { userPlanFeatures } = context;

  if (userPlanFeatures === undefined) {
    throw new Error("User plan features are not defined");
  }

  const { sourceOrigin } = parseBuilderUrl(request.url);

  return json({
    user,
    projects,
    projectTemplates,
    userPlanFeatures,
    publisherHost: env.PUBLISHER_HOST,
    imageBaseUrl: env.IMAGE_BASE_URL,
    origin: sourceOrigin,
  });
};

/**
 * When deleting/adding a project, then navigating to a new project and pressing the back button,
 * the dashboard page may display stale data because it’s being retrieved from the browser’s back/forward cache (bfcache).
 *
 * https://web.dev/articles/bfcache
 *
 */
export const headers = () => {
  return {
    "Cache-Control": "no-store",
  };
};

const Dashboard = lazy(async () => {
  const { Dashboard } = await import("~/dashboard/index.client");
  return { default: Dashboard };
});

const DashboardRoute = () => {
  const data = useLoaderData<typeof loader>();

  return (
    <>
      {data.projects.slice(0, 5).map((project) => {
        prefetchDNS(builderUrl({ projectId: project.id, origin: data.origin }));
      })}
      {data.projects.slice(0, 5).map((project) => {
        preconnect(builderUrl({ projectId: project.id, origin: data.origin }));
      })}
      <ClientOnly>
        <Dashboard {...data} />
      </ClientOnly>
    </>
  );
};

export default DashboardRoute;
