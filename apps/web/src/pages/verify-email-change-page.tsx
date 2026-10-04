import { verifyEmailChange } from "@/api";
import { VerifyTokenPage } from "./verify-token-page";

export function VerifyEmailChangePage({ token }: { token: string }) {
  return (
    <VerifyTokenPage
      invalid="auth.verifyEmailChangeInvalid"
      queryKey="verify-email-change"
      success="auth.verifyEmailChangeSuccess"
      title="auth.verifyEmailChangeTitle"
      token={token}
      verify={verifyEmailChange}
    />
  );
}
