import { PasswordInput } from "@/components/ui/password-input";
import { useI18n } from "@/i18n";

export const MIN_PASSWORD_LENGTH = 8;

/**
 * The new-password + confirmation field pair shared by the reset and
 * recover flows. `idPrefix` keeps input ids (and their label htmlFor)
 * unique per page so autofill and a11y stay scoped to the active route.
 */
export function NewPasswordFields({
  idPrefix,
  newPassword,
  confirmation,
  disabled,
  onNewPasswordChange,
  onConfirmationChange,
}: {
  idPrefix: string;
  newPassword: string;
  confirmation: string;
  disabled: boolean;
  onNewPasswordChange: (value: string) => void;
  onConfirmationChange: (value: string) => void;
}) {
  const { t } = useI18n();
  const newPasswordId = `${idPrefix}-new-password`;
  const confirmationId = `${idPrefix}-confirmation`;
  return (
    <>
      <label
        className="flex flex-col gap-1.5 text-sm font-medium"
        htmlFor={newPasswordId}
      >
        {t("auth.newPassword")}
        <PasswordInput
          autoComplete="new-password"
          disabled={disabled}
          id={newPasswordId}
          minLength={MIN_PASSWORD_LENGTH}
          required
          value={newPassword}
          onChange={(event) => onNewPasswordChange(event.target.value)}
        />
      </label>
      <label
        className="flex flex-col gap-1.5 text-sm font-medium"
        htmlFor={confirmationId}
      >
        {t("auth.confirmPassword")}
        <PasswordInput
          autoComplete="new-password"
          disabled={disabled}
          id={confirmationId}
          minLength={MIN_PASSWORD_LENGTH}
          required
          value={confirmation}
          onChange={(event) => onConfirmationChange(event.target.value)}
        />
      </label>
    </>
  );
}
