import { useNavigate } from "@tanstack/react-router";
import { FolderKanbanIcon } from "lucide-react";
import { useCallback } from "react";
import { WorkspaceLayout } from "@/components/workspace/workspace-layout";
import { WorkspacePageHeader } from "@/components/workspace/workspace-page-header";
// The workbench retains the validated memo protocol and its client-side
// concurrency guards while it is integrated into FlareMo's authenticated shell.
// @ts-expect-error The existing workbench is a JavaScript feature module.
import { DemoApp as TeamProjectsApp } from "@/features/team-projects/team-projects-app.jsx";
import { useI18n } from "@/i18n";

export function TeamProjectsPage() {
  const { t } = useI18n();
  const navigate = useNavigate();
  const navigateTeam = useCallback(
    (search: Record<string, string>, replace = false) => {
      const value = (key: string) => search[key] || undefined;
      return navigate({
        to: "/team-projects",
        search: {
          project: value("project"),
          edit: value("edit") === "1" ? true : undefined,
          new: value("new"),
          view: value("view"),
          member: value("member"),
          phase: value("phase"),
          q: value("q"),
          owner: value("owner"),
          group: value("group"),
        },
        replace,
      });
    },
    [navigate],
  );
  return (
    <WorkspaceLayout
      maxWidthClass="max-w-[1600px]"
      outerMaxWidthClass="max-w-[1800px]"
      header={(props) => (
        <WorkspacePageHeader
          {...props}
          icon={
            <FolderKanbanIcon
              aria-hidden="true"
              className="size-4 text-brand-500"
            />
          }
          title={t("nav.teamProjects")}
          maxWidthClass="max-w-[1600px]"
        />
      )}
    >
      <TeamProjectsApp navigateTeam={navigateTeam} />
    </WorkspaceLayout>
  );
}
