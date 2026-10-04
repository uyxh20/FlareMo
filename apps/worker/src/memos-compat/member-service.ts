/**
 * Member registration shared by every Memos compatibility surface: the
 * Better Auth identity, the linked FlareMo member row, and the native Memos
 * token pair are one unit of work. All surfaces previously carried their own
 * copies, and the copies had drifted — the Connect CreateUser and SignUp
 * paths skipped the member-quota pre-check the current REST surface ran
 * before creating the auth identity. The pre-check now lives here, so a
 * spent member quota can never orphan a Better Auth user through any compat
 * surface.
 */
import type { FlareMoDb, UserRow } from "@flaremo/db";
import {
  assertMemberQuota,
  createFlaremoMemberWithLink,
  type PlanLimits,
} from "@flaremo/domain";
import { loadAuthFactory } from "../context";
import type { FlareMoEnv } from "../env";

export type CompatMemberRegistrationInput = {
  env: FlareMoEnv;
  db: FlareMoDb;
  limits: PlanLimits;
  username: string;
  password: string;
  displayName: string;
  email: string;
};

export async function registerCompatMember(
  input: CompatMemberRegistrationInput,
): Promise<{ authUserId: string; user: UserRow }> {
  // Pre-check before the Better Auth identity exists so a spent member
  // quota cannot orphan an auth user.
  await assertMemberQuota(input.db, input.limits);
  const { createFlareMoAuth } = await loadAuthFactory();
  const auth = createFlareMoAuth(input.env, input.db, {
    allowBootstrapSignUp: true,
  });
  const result = await auth.api.signUpEmail({
    body: {
      email: input.email,
      name: input.displayName,
      password: input.password,
      username: input.username,
      displayUsername: input.username,
    },
  });
  const user = await createFlaremoMemberWithLink(
    input.db,
    {
      authUserId: result.user.id,
      email: input.email,
      name: input.displayName,
    },
    input.limits,
  );
  return { authUserId: result.user.id, user };
}
