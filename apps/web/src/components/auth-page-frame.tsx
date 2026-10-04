import type { ReactNode } from "react";
import { FlareMoLogo } from "@/components/flaremo-logo";
import { InfoTip } from "@/components/info-tip";
import { LocaleSwitcher } from "@/components/locale-switcher";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { useI18n } from "@/i18n";

export function AuthPageFrame({
  children,
  description,
  eyebrow,
  title,
}: {
  children: ReactNode;
  description?: string;
  eyebrow?: string;
  title: string;
}) {
  const { t } = useI18n();

  return (
    <main className="grid min-h-svh lg:grid-cols-2" data-auth-page>
      <aside className="relative hidden bg-muted lg:flex lg:flex-col lg:justify-between lg:border-r lg:border-border/60 lg:p-12">
        <div className="flex items-center gap-2.5">
          <FlareMoLogo labelClassName="text-lg" markClassName="size-8" />
        </div>
        <div className="relative max-w-md py-16">
          <h1 className="max-w-sm font-heading text-4xl font-semibold leading-tight tracking-tight text-ink xl:text-5xl">
            {t("auth.brandTitle")}
          </h1>
        </div>
      </aside>
      <div className="relative flex items-center justify-center bg-background px-4 py-8">
        <header className="absolute inset-x-0 top-0 flex items-center justify-between p-4 lg:justify-end">
          <span className="lg:hidden">
            <FlareMoLogo labelClassName="text-lg" markClassName="size-7" />
          </span>
          <LocaleSwitcher />
        </header>
        <Card className="w-full max-w-md shadow-lg">
          <CardHeader className="gap-2">
            {eyebrow ? (
              <p className="text-xs font-semibold tracking-[0.16em] text-primary uppercase">
                {eyebrow}
              </p>
            ) : null}
            <CardTitle className="text-xl">{title}</CardTitle>
            {description ? (
              <CardDescription className="flex items-start gap-1.5">
                <InfoTip text={description} />
                <span className="sr-only">{description}</span>
              </CardDescription>
            ) : null}
          </CardHeader>
          <CardContent>{children}</CardContent>
        </Card>
      </div>
    </main>
  );
}
