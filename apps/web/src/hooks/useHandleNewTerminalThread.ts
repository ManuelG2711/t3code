import { scopeProjectRef } from "@t3tools/client-runtime";
import {
  DEFAULT_RUNTIME_MODE,
  type ModelSelection,
  type ScopedProjectRef,
} from "@t3tools/contracts";
import { useRouter } from "@tanstack/react-router";
import { useCallback, useMemo } from "react";
import { useShallow } from "zustand/react/shallow";
import { readEnvironmentApi } from "../environmentApi";
import { newCommandId, newThreadId } from "../lib/utils";
import { orderItemsByPreferredIds } from "../components/Sidebar.logic";
import { getProjectOrderKey } from "../logicalProject";
import { resolveAppModelSelectionState } from "../modelSelection";
import { useServerProviders } from "../rpc/serverState";
import { selectProjectsAcrossEnvironments, useStore } from "../store";
import { useUiStateStore } from "../uiStateStore";
import { useSettings } from "./useSettings";

/**
 * Creates a terminal-only thread.
 *
 * Unlike {@link useHandleNewThread}, this dispatches `thread.create` directly
 * (with `kind: "terminal"`) and navigates straight to the server thread route.
 * Terminal threads never start an agent turn, so there is no draft to promote
 * and no first message to wait for. `modelSelection` is required by the command
 * schema but is never used by a terminal thread, so we pass a sensible default.
 */
function useNewTerminalThreadState() {
  const projects = useStore(useShallow((store) => selectProjectsAcrossEnvironments(store)));
  const providers = useServerProviders();
  const settings = useSettings();
  const router = useRouter();

  return useCallback(
    (
      projectRef: ScopedProjectRef,
      options?: {
        branch?: string | null;
        worktreePath?: string | null;
      },
    ): Promise<void> => {
      const project = projects.find(
        (candidate) =>
          candidate.id === projectRef.projectId &&
          candidate.environmentId === projectRef.environmentId,
      );
      const modelSelection: ModelSelection =
        project?.defaultModelSelection ?? resolveAppModelSelectionState(settings, providers);

      const api = readEnvironmentApi(projectRef.environmentId);
      if (!api) {
        return Promise.resolve();
      }

      const threadId = newThreadId();
      const createdAt = new Date().toISOString();

      return api.orchestration
        .dispatchCommand({
          type: "thread.create",
          commandId: newCommandId(),
          threadId,
          projectId: projectRef.projectId,
          title: "Terminal",
          modelSelection,
          runtimeMode: DEFAULT_RUNTIME_MODE,
          interactionMode: "default",
          kind: "terminal",
          branch: options?.branch ?? null,
          worktreePath: options?.worktreePath ?? null,
          createdAt,
        })
        .then(() =>
          router.navigate({
            to: "/$environmentId/$threadId",
            params: {
              environmentId: projectRef.environmentId,
              threadId,
            },
          }),
        )
        .then(() => undefined);
    },
    [projects, providers, settings, router],
  );
}

export function useNewTerminalThreadHandler() {
  const handleNewTerminalThread = useNewTerminalThreadState();
  return { handleNewTerminalThread };
}

export function useHandleNewTerminalThread() {
  const projectOrder = useUiStateStore((store) => store.projectOrder);
  const projects = useStore(useShallow((store) => selectProjectsAcrossEnvironments(store)));
  const orderedProjects = useMemo(
    () =>
      orderItemsByPreferredIds({
        items: projects,
        preferredIds: projectOrder,
        getId: getProjectOrderKey,
      }),
    [projectOrder, projects],
  );
  const handleNewTerminalThread = useNewTerminalThreadState();

  return {
    handleNewTerminalThread,
    defaultProjectRef: orderedProjects[0]
      ? scopeProjectRef(orderedProjects[0].environmentId, orderedProjects[0].id)
      : null,
  };
}
