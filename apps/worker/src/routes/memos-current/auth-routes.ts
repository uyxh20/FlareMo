import {
  ForbiddenError,
  getFlaremoUserByAuthSessionToken,
  revokeAuthSessionByToken,
  SELF_HOST_UNLIMITED,
  UnauthorizedError,
} from "@flaremo/domain";
import type { Hono } from "hono";
import { verifyCaptchaRequest } from "../../captcha";
import {
  assertTrustedCookieMutation,
  getRequestContext,
  type HonoBindings,
} from "../../context";
import { resolveEmailSendConfig } from "../../email";
import { currentJsonError } from "../../memos-compat/current-errors";
import { registerCompatMember } from "../../memos-compat/member-service";
import {
  authenticateMemosAccessToken,
  getMemosRefreshToken,
  issueMemosNativeTokens,
  revokeMemosRefreshToken,
  rotateMemosRefreshToken,
} from "../../memos-native-auth";
import { rateLimitGuard } from "../../rate-limit";
import {
  appendMemosRefreshClearCookie,
  assertRegistrationOpen,
  copyHeaders,
  createAuthContext,
  currentUserForContext,
  isLegacyWireRequest,
  nativeRefreshResponse,
  noStoreResponse,
  parseBearerToken,
  readCurrentJsonObject,
  signOutCookieSession,
} from "./helpers";
import { currentSigninSchema, currentSignupSchema } from "./schemas";

export function registerAuthRoutes(app: Hono<HonoBindings>) {
  app.get("/auth/me", async (c, next) => {
    if (isLegacyWireRequest(c)) return next();
    try {
      const context = await getRequestContext(c);
      return c.json({ user: await currentUserForContext(context) });
    } catch (error) {
      return currentJsonError(c, error);
    }
  });

  app.post("/auth/signin", async (c, next) => {
    if (isLegacyWireRequest(c)) return next();
    try {
      // Credential brute-force surface: same per-IP edge bucket as /api/auth/*.
      const throttled = await rateLimitGuard(c, "auth");
      if (throttled) return throttled;
      // This endpoint creates a browser cookie as well as returning the opaque
      // session-backed access token. Treat it as a cookie mutation even when a
      // Memos-compatible client chooses to use the bearer token afterward.
      assertTrustedCookieMutation(c);
      const credentials = currentSigninSchema.parse(
        await readCurrentJsonObject(c),
      ).passwordCredentials;
      const dbContext = await createAuthContext(c);
      const result = await dbContext.auth.api.signInUsername({
        body: {
          username: credentials.username,
          password: credentials.password,
          rememberMe: true,
        },
        headers: c.req.raw.headers,
        asResponse: false,
        returnHeaders: true,
      });
      const session = await getFlaremoUserByAuthSessionToken(
        dbContext.db,
        result.response.token,
      );
      if (!session) {
        throw new Error(
          "Better Auth returned a session that could not be resolved",
        );
      }
      const nativeTokens = await issueMemosNativeTokens({
        db: dbContext.db,
        env: c.env,
        authUserId: session.authUserId,
        user: session.user,
        request: c.req.raw,
      });
      const response = c.json(
        {
          user: await currentUserForContext({
            ...dbContext,
            user: session.user,
            authUserId: session.authUserId,
          }),
          accessToken: nativeTokens.accessToken,
          accessTokenExpiresAt: nativeTokens.accessTokenExpiresAt.toISOString(),
        },
        200,
      );
      copyHeaders(response.headers, result.headers);
      response.headers.append("set-cookie", nativeTokens.refreshCookie);
      response.headers.set("cache-control", "no-store");
      return response;
    } catch (error) {
      return currentJsonError(c, error);
    }
  });

  app.post("/auth/signup", async (c, next) => {
    if (isLegacyWireRequest(c)) return next();
    try {
      assertTrustedCookieMutation(c);
      const input = currentSignupSchema.parse(await readCurrentJsonObject(c));
      await assertRegistrationOpen(c);
      const dbContext = await createAuthContext(c);
      // With a transactional-email provider configured, registration requires
      // verifying a real mailbox through the web app. This compat surface
      // cannot complete that flow, so refuse rather than minting unverified
      // accounts that bypass the deployment's anti-abuse gate.
      if (
        (await resolveEmailSendConfig(c.env, dbContext.db)).provider !== "none"
      ) {
        throw new ForbiddenError(
          "Email verification is required. Please use the FlareMo web app to sign up.",
        );
      }
      await verifyCaptchaRequest(c.env, c.req.raw);
      const username = input.username.trim();
      const email = input.email?.trim() || `${username}@flaremo.local`;
      const displayName = input.displayName?.trim() || username;
      const { authUserId, user } = await registerCompatMember({
        env: c.env,
        db: dbContext.db,
        limits: c.get("planLimits") ?? SELF_HOST_UNLIMITED,
        username,
        password: input.password,
        displayName,
        email,
      });
      const nativeTokens = await issueMemosNativeTokens({
        db: dbContext.db,
        env: c.env,
        authUserId,
        user,
        request: c.req.raw,
      });
      const response = noStoreResponse(
        c.json(
          {
            user: await currentUserForContext({
              ...dbContext,
              user,
              authUserId,
            }),
            accessToken: nativeTokens.accessToken,
            accessTokenExpiresAt:
              nativeTokens.accessTokenExpiresAt.toISOString(),
          },
          201,
        ),
      );
      response.headers.append("set-cookie", nativeTokens.refreshCookie);
      return response;
    } catch (error) {
      return currentJsonError(c, error);
    }
  });

  app.post("/auth/refresh", async (c, next) => {
    if (isLegacyWireRequest(c)) return next();
    try {
      const authorization = c.req.header("authorization");
      if (authorization) {
        const token = parseBearerToken(authorization);
        const bearerContext = await getRequestContext(c);
        const nativeAccess = await authenticateMemosAccessToken({
          db: bearerContext.db,
          env: c.env,
          token,
        });
        if (nativeAccess) {
          // A native refresh is cookie-authenticated. If a caller also sends a
          // bearer token, it is only an optional user-binding check; the
          // refresh token itself must still be present in memos_refresh.
          if (c.req.raw.headers.get("cookie")) {
            assertTrustedCookieMutation(c);
          }
          if (getMemosRefreshToken(c.req.raw.headers)) {
            const rotated = await rotateMemosRefreshToken({
              db: bearerContext.db,
              env: c.env,
              request: c.req.raw,
              expectedAuthUserId: nativeAccess.authUserId,
            });
            if (!rotated) throw new UnauthorizedError();
            return nativeRefreshResponse(c, rotated);
          }

          // Preserve the previous FlareMo session-bearer facade for clients
          // that have not adopted the new refresh cookie yet. This compatibility
          // response is not a refresh operation and cannot mint a new token.
          const authContext = await createAuthContext(c);
          const session = await authContext.auth.api.getSession({
            headers: c.req.raw.headers,
            query: { disableCookieCache: true },
          });
          if (!session || session.user.id !== nativeAccess.authUserId) {
            throw new UnauthorizedError();
          }
          return noStoreResponse(
            c.json({
              accessToken: token,
              expiresAt: new Date(
                nativeAccess.claims.expiresAt * 1_000,
              ).toISOString(),
            }),
          );
        }

        // Existing opaque Better Auth session bearers remain accepted here for
        // compatibility. A Memos PAT is an application credential, not a
        // refreshable browser session.
        if (!bearerContext.bearerSession || !bearerContext.session) {
          throw new UnauthorizedError();
        }
        return noStoreResponse(
          c.json({
            accessToken: token,
            expiresAt: bearerContext.session.expiresAt.toISOString(),
          }),
        );
      }

      assertTrustedCookieMutation(c);
      const rotated = await rotateMemosRefreshToken({
        db: (await createAuthContext(c)).db,
        env: c.env,
        request: c.req.raw,
      });
      if (!rotated) throw new UnauthorizedError();
      return nativeRefreshResponse(c, rotated);
    } catch (error) {
      return currentJsonError(c, error);
    }
  });

  app.post("/auth/signout", async (c, next) => {
    if (isLegacyWireRequest(c)) return next();
    try {
      const authorization = c.req.header("authorization");
      if (authorization) {
        const token = parseBearerToken(authorization);
        const context = await getRequestContext(c);
        const hasCookie = Boolean(c.req.raw.headers.get("cookie"));
        if (hasCookie) assertTrustedCookieMutation(c);

        if (context.nativeAccessToken) {
          await revokeMemosRefreshToken({
            db: context.db,
            env: c.env,
            headers: c.req.raw.headers,
            expectedAuthUserId: context.authUserId,
          });
          if (hasCookie) {
            const response = await signOutCookieSession(c, context.db);
            return appendMemosRefreshClearCookie(response, c.req.raw);
          }
          return appendMemosRefreshClearCookie(c.body(null, 200), c.req.raw);
        }

        if (context.credential === "pat") {
          // A PAT does not have a browser session to revoke, but it still must
          // be valid. Do not return success for arbitrary bearer strings.
          if (hasCookie) {
            const response = await signOutCookieSession(c, context.db);
            return appendMemosRefreshClearCookie(response, c.req.raw);
          }
          return c.body(null, 200);
        }

        await revokeAuthSessionByToken(context.db, token);
        if (hasCookie) {
          const response = await signOutCookieSession(c, context.db);
          return appendMemosRefreshClearCookie(response, c.req.raw);
        }
        return c.body(null, 200);
      }

      const context = await getRequestContext(c);
      await revokeMemosRefreshToken({
        db: context.db,
        env: c.env,
        headers: c.req.raw.headers,
        expectedAuthUserId: context.authUserId,
      });
      const response = await signOutCookieSession(c, context.db);
      return appendMemosRefreshClearCookie(response, c.req.raw);
    } catch (error) {
      return currentJsonError(c, error);
    }
  });
}
