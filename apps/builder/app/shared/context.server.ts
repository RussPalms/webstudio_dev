import { type AppContext } from "@webstudio-is/trpc-interface/index.server";
import env from "~/env/env.server";
import { authenticator } from "~/services/auth.server";
import { trpcSharedClient } from "~/services/trpc.server";
import { entryApi } from "./entri/entri-api.server";

import { getUserPlanFeatures } from "./db/user-plan-features.server";
import { staticEnv } from "~/env/env.static.server";
import { createClient } from "@webstudio-is/postrest/index.server";
import { prisma } from "@webstudio-is/prisma-client";
import { builderAuthenticator } from "~/services/builder-auth.server";
import { readLoginSessionBloomFilter } from "~/services/session.server";
import type { BloomFilter } from "~/services/bloom-filter.server";
import { isBuilder, isCanvas, isDashboard } from "./router-utils";
import { parseBuilderUrl } from "@webstudio-is/http-client";

export const extractAuthFromRequest = async (request: Request) => {
  if (isCanvas(request)) {
    throw new Error("Canvas requests can't have authorization context");
  }
  const url = new URL(request.url);

  const authToken =
    url.searchParams.get("authToken") ??
    request.headers.get("x-auth-token") ??
    undefined;

  const sessionData = isBuilder(request)
    ? await builderAuthenticator.isAuthenticated(request)
    : await authenticator.isAuthenticated(request);

  const isServiceCall =
    request.headers.has("Authorization") &&
    request.headers.get("Authorization") === env.TRPC_SERVER_API_TOKEN;

  return {
    authToken,
    sessionData,
    isServiceCall,
  };
};

const createAuthorizationContext = async (
  request: Request
): Promise<AppContext["authorization"]> => {
  if (isCanvas(request)) {
    throw new Error("Canvas requests can't have authorization context");
  }

  const { authToken, isServiceCall, sessionData } =
    await extractAuthFromRequest(request);

  let ownerId = sessionData?.userId;

  if (authToken != null) {
    const projectOwnerIdByToken = await prisma.authorizationToken.findUnique({
      where: {
        token: authToken,
      },
      select: {
        project: {
          select: {
            id: true,
            userId: true,
          },
        },
      },
    });

    if (projectOwnerIdByToken === null) {
      throw new Error(`Project owner can't be found for token ${authToken}`);
    }

    const projectOwnerId = projectOwnerIdByToken.project.userId;
    if (projectOwnerId === null) {
      throw new Error(
        `Project ${projectOwnerIdByToken.project.id} has null userId`
      );
    }
    ownerId = projectOwnerId;
  }

  let loginBloomFilter: BloomFilter | undefined = undefined;
  let isLoggedInToBuilder:
    | AppContext["authorization"]["isLoggedInToBuilder"]
    | undefined = undefined;

  if (isDashboard(request) && sessionData?.userId !== undefined) {
    isLoggedInToBuilder = async (projectId: string) => {
      if (loginBloomFilter === undefined) {
        loginBloomFilter = await readLoginSessionBloomFilter(request);
      }

      return await loginBloomFilter.has(projectId);
    };
  }

  if (isBuilder(request) && sessionData?.userId !== undefined) {
    isLoggedInToBuilder = async (projectId: string) => {
      const parsedUrl = parseBuilderUrl(request.url);
      return parsedUrl.projectId === projectId;
    };
  }

  const context: AppContext["authorization"] = {
    userId: sessionData?.userId,
    sessionCreatedAt: sessionData?.createdAt,
    authToken,
    isServiceCall,
    ownerId,
    isLoggedInToBuilder,
  };

  return context;
};

const createDomainContext = (_request: Request) => {
  const context: AppContext["domain"] = {
    domainTrpc: trpcSharedClient.domain,
  };

  return context;
};

const getRequestOrigin = (urlStr: string) => {
  const url = new URL(urlStr);

  return url.origin;
};

const createDeploymentContext = (request: Request) => {
  const context: AppContext["deployment"] = {
    deploymentTrpc: trpcSharedClient.deployment,
    env: {
      BUILDER_ORIGIN: `${getRequestOrigin(request.url)}`,
      GITHUB_REF_NAME: staticEnv.GITHUB_REF_NAME ?? "undefined",
      GITHUB_SHA: staticEnv.GITHUB_SHA ?? undefined,
    },
  };

  return context;
};

const createEntriContext = () => {
  return {
    entryApi,
  };
};

const createUserPlanContext = async (
  authorization: AppContext["authorization"]
) => {
  const planFeatures = authorization.ownerId
    ? await getUserPlanFeatures(authorization.ownerId)
    : undefined;
  return planFeatures;
};

const createTrpcCache = () => {
  const proceduresMaxAge = new Map<string, number>();
  const setMaxAge = (path: string, value: number) => {
    proceduresMaxAge.set(
      path,
      Math.min(proceduresMaxAge.get(path) ?? Number.MAX_SAFE_INTEGER, value)
    );
  };

  const getMaxAge = (path: string) => proceduresMaxAge.get(path);

  return {
    setMaxAge,
    getMaxAge,
  };
};

export const createPostrestContext = () => {
  return { client: createClient(env.POSTGREST_URL, env.POSTGREST_API_KEY) };
};

/**
 * argument buildEnv==="prod" only if we are loading project with production build
 */
export const createContext = async (request: Request): Promise<AppContext> => {
  const authorization = await createAuthorizationContext(request);

  const domain = createDomainContext(request);
  const deployment = createDeploymentContext(request);
  const entri = createEntriContext();
  const userPlanFeatures = await createUserPlanContext(authorization);
  const trpcCache = createTrpcCache();
  const postgrest = createPostrestContext();

  return {
    authorization,
    domain,
    deployment,
    entri,
    userPlanFeatures,
    trpcCache,
    postgrest,
  };
};
