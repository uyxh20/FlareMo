import type { createDb } from "@flaremo/db";
import type { PlanLimits } from "@flaremo/domain";
import { currentUserToDto } from "@flaremo/memos";
import { getFlareMoAuth } from "../../../context";
import { getAuthUserCached } from "../../../identity-cache";
import { CompatValidationError } from "../../../memos-compat/errors";
import { registerCompatMember } from "../../../memos-compat/member-service";
import type { ConnectContext, ConnectRequestContext } from "../shared";

/**
 * Better Auth owns the credential rows, so a username change has to travel
 * through its own handler with the caller's cookie session; a bearer-only or
 * PAT caller cannot rename the account.
 */
export async function updateBetterAuthUsername(
  c: ConnectContext,
  _context: ConnectRequestContext,
  username: string,
) {
  if (!c.req.raw.headers.get("cookie")) {
    throw new CompatValidationError(
      "A Better Auth cookie session is required to update the username",
    );
  }
  const headers = new Headers(c.req.raw.headers);
  headers.set("content-type", "application/json");
  const request = new Request(new URL("/api/auth/update-user", c.req.url), {
    method: "POST",
    headers,
    body: JSON.stringify({ username }),
  });
  const response = await (await getFlareMoAuth(c.env)).handler(request);
  if (response.ok) return;
  let message = "Better Auth rejected the username update";
  try {
    const payload = (await response.json()) as { message?: unknown };
    if (typeof payload.message === "string" && payload.message) {
      message = payload.message;
    }
  } catch {
    // Keep the stable compatibility error when Better Auth did not return JSON.
  }
  throw new CompatValidationError(message);
}

export async function createConnectUser(
  c: ConnectContext,
  db: ReturnType<typeof createDb>,
  input: {
    username: string;
    password: string;
    displayName: string;
    email: string;
  },
  limits: PlanLimits,
) {
  const { authUserId, user } = await registerCompatMember({
    env: c.env,
    db,
    limits,
    ...input,
  });
  return {
    authUserId,
    user,
    dto: currentUserToDto(user, await getAuthUserCached(db, authUserId)),
  };
}
