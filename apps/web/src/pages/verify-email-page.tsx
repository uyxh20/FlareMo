import { verifyEmail } from "@/api";
import { VerifyTokenPage } from "./verify-token-page";

export function VerifyEmailPage({ token }: { token: string }) {
  return (
    <VerifyTokenPage
      invalid="auth.verifyEmailInvalid"
      queryKey="verify-email"
      success="auth.verifyEmailSuccess"
      title="auth.verifyEmailTitle"
      token={token}
      verify={verifyEmail}
    />
  );
}
