import { useQuery, useQueryClient } from "@tanstack/react-query";
import { FolderKanbanIcon, ListTodoIcon, PlusIcon } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { listProjects, listTasks } from "@/api";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { WorkspaceLayout } from "@/components/workspace/workspace-layout";
import { WorkspacePageHeader } from "@/components/workspace/workspace-page-header";
import { useI18n } from "@/i18n";
import { queryKeys } from "@/lib/query-keys";
import { Board } from "./projects/board";
import { ALL_TASKS } from "./projects/constants";
import { ProjectFormDialog } from "./projects/project-form-dialog";
import { ProjectRow } from "./projects/project-row";
import { TaskFormDialog } from "./projects/task-form-dialog";
import { TrashSection } from "./projects/trash-section";

export function ProjectsPage() {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const [selected, setSelected] = useState<string>(ALL_TASKS);
  const [creatingProject, setCreatingProject] = useState(false);
  const [creatingTask, setCreatingTask] = useState(false);

  const projectsQuery = useQuery({
    queryKey: ["projects"],
    queryFn: () => listProjects(),
  });

  const tasksQuery = useQuery({
    // Same key as the mini calendar's all-tasks query so the board reuses
    // that cache instead of re-fetching the same payload under ["tasks","all"].
    queryKey:
      selected === ALL_TASKS
        ? queryKeys.tasks.all
        : queryKeys.tasks.byProject(selected),
    queryFn: () =>
      listTasks(selected === ALL_TASKS ? {} : { project_id: selected }),
  });

  const projects = useMemo(
    () => projectsQuery.data?.projects ?? [],
    [projectsQuery.data],
  );
  const tasks = useMemo(() => tasksQuery.data?.tasks ?? [], [tasksQuery.data]);
  const projectById = useMemo(
    () => new Map(projects.map((project) => [project.id, project])),
    [projects],
  );

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ["projects"] });
    void queryClient.invalidateQueries({ queryKey: queryKeys.tasks.all });
    // The calendar aggregates dues/overdue from the same task rows; without
    // this prefix it keeps serving a stale board for the refetch interval.
    void queryClient.invalidateQueries({ queryKey: ["calendar"] });
  };

  const selectedProject =
    selected === ALL_TASKS ? null : (projectById.get(selected) ?? null);
  const openCount = projects.reduce(
    (sum, project) => sum + project.task_count_open,
    0,
  );

  // A deleted (or otherwise vanished) project must never leave the board
  // pointed at a filter that matches nothing: fall back to "全部任务".
  useEffect(() => {
    if (!projectsQuery.data) return;
    if (selected !== ALL_TASKS && !projectById.has(selected)) {
      setSelected(ALL_TASKS);
    }
  }, [selected, projectById, projectsQuery.data]);

  return (
    <WorkspaceLayout
      maxWidthClass="max-w-5xl"
      header={({
        sidebarCollapsed,
        toggleSidebarCollapsed,
        mobileSheetOpen,
        setMobileSheetOpen,
        explorer,
      }) => (
        <WorkspacePageHeader
          actions={
            <>
              <Button
                size="sm"
                variant="outline"
                onClick={() => setCreatingTask(true)}
              >
                <PlusIcon data-icon="inline-start" />
                {t("projects.newTask")}
              </Button>
              <Button size="sm" onClick={() => setCreatingProject(true)}>
                <PlusIcon data-icon="inline-start" />
                {t("projects.newProject")}
              </Button>
            </>
          }
          explorer={explorer}
          icon={
            <FolderKanbanIcon className="size-4 shrink-0 text-brand-600 dark:text-brand-400" />
          }
          maxWidthClass="max-w-5xl"
          mobileSheetOpen={mobileSheetOpen}
          setMobileSheetOpen={setMobileSheetOpen}
          sidebarCollapsed={sidebarCollapsed}
          title={t("projects.title")}
          toggleSidebarCollapsed={toggleSidebarCollapsed}
        />
      )}
    >
      <div className="flex flex-col gap-4 py-2">
        <div className="flex flex-col gap-4 lg:flex-row">
          <aside className="flex w-full shrink-0 flex-col gap-1 lg:w-64">
            <button
              className={
                "flex h-10 items-center gap-3 rounded-lg px-3 text-sm " +
                (selected === ALL_TASKS
                  ? "bg-muted text-foreground"
                  : "text-muted-foreground hover:bg-muted hover:text-foreground")
              }
              type="button"
              onClick={() => setSelected(ALL_TASKS)}
            >
              <ListTodoIcon className="size-4" />
              <span className="min-w-0 flex-1 truncate text-left">
                {t("projects.allTasks")}
              </span>
              <Badge variant="secondary">{openCount}</Badge>
            </button>

            {projectsQuery.isLoading && (
              <div className="flex flex-col gap-2 px-3 py-2">
                <Skeleton className="h-8 w-full" />
                <Skeleton className="h-8 w-full" />
              </div>
            )}

            {projectsQuery.isError && !projectsQuery.data && (
              <div className="flex items-center gap-2 px-3 py-2 text-xs text-muted-foreground">
                <span className="min-w-0 flex-1">
                  {t("list.errorDescription")}
                </span>
                <Button
                  className="h-6 px-2 text-xs"
                  size="sm"
                  type="button"
                  variant="outline"
                  onClick={() => void projectsQuery.refetch()}
                >
                  {t("common.retry")}
                </Button>
              </div>
            )}

            {projects.map((project) => (
              <ProjectRow
                key={project.id}
                project={project}
                selected={selected === project.id}
                onMutated={invalidate}
                onSelect={setSelected}
                onDeleted={(id) => {
                  if (selected === id) setSelected(ALL_TASKS);
                }}
              />
            ))}

            <TrashSection onMutated={invalidate} />
          </aside>

          <section className="min-w-0 flex-1">
            <div className="mb-3 px-1">
              <h2 className="truncate text-sm font-medium text-muted-foreground">
                {selectedProject
                  ? selectedProject.name
                  : t("projects.allTasks")}
              </h2>
            </div>

            <Board
              hasError={tasksQuery.isError && !tasksQuery.data}
              hasProjects={projects.length > 0}
              isRetrying={tasksQuery.isRefetching}
              loading={tasksQuery.isLoading}
              projectById={projectById}
              selectedProject={selectedProject}
              tasks={tasks}
              onRetry={() => void tasksQuery.refetch()}
              onMutated={invalidate}
              onCreateProject={() => setCreatingProject(true)}
              onCreateTask={() => setCreatingTask(true)}
            />
          </section>
        </div>

        <ProjectFormDialog
          open={creatingProject}
          onOpenChange={setCreatingProject}
          onSaved={invalidate}
        />
        <TaskFormDialog
          defaultProjectId={selectedProject?.id}
          open={creatingTask}
          onOpenChange={setCreatingTask}
          onSaved={invalidate}
        />
      </div>
    </WorkspaceLayout>
  );
}
