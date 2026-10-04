import type { Memory } from "@/api";
import { QueryErrorState } from "@/components/query-error-state";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@/components/ui/empty";
import { Skeleton } from "@/components/ui/skeleton";
import { useI18n } from "@/i18n";
import { MemoryCard } from "./memory-card";

export function MemoryList({
  memories,
  loading,
  hasError,
  isRetrying,
  onRetry,
  onMutated,
  emptyTitle,
  showSource = false,
  review = false,
  onSelectProject,
}: {
  memories: Memory[];
  loading: boolean;
  hasError?: boolean;
  isRetrying?: boolean;
  onRetry?: () => void;
  onMutated: () => void;
  emptyTitle?: string;
  showSource?: boolean;
  review?: boolean;
  onSelectProject?: (projectKey: string) => void;
}) {
  const { t } = useI18n();

  if (hasError) {
    return (
      <QueryErrorState
        className="min-h-56"
        isRetrying={isRetrying}
        onRetry={onRetry ?? (() => undefined)}
      />
    );
  }

  if (loading) {
    return (
      <div className="flex flex-col gap-3">
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-24 w-full" />
      </div>
    );
  }

  if (memories.length === 0) {
    return (
      <Empty className="min-h-56 border">
        <EmptyHeader>
          <EmptyTitle>
            {emptyTitle ??
              (review ? t("memory.reviewEmpty") : t("memory.emptyTitle"))}
          </EmptyTitle>
          {!review && !emptyTitle && (
            <EmptyDescription>{t("memory.emptyDescription")}</EmptyDescription>
          )}
        </EmptyHeader>
      </Empty>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      {memories.map((memory) => (
        <MemoryCard
          key={memory.id}
          memory={memory}
          showSource={showSource}
          review={review}
          onSelectProject={onSelectProject}
          onMutated={onMutated}
        />
      ))}
    </div>
  );
}
