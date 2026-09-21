import { useMobileGitStatus } from "../../state/queries";
import { useIsFocused } from "@react-navigation/native";
import { Platform } from "react-native";
import { useSelectedThreadGitActions } from "../../state/use-selected-thread-git-actions";
import { useSelectedThreadGitState } from "../../state/use-selected-thread-git-state";
import { useThreadSelection } from "../../state/use-thread-selection";
import { useThreadGitMenuDefinition } from "../threads/ThreadGitControls";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import type { ReviewSectionItem } from "./reviewModel";
import type { ScreenHeaderMenuItem, ScreenHeaderMenu } from "../../components/ScreenHeader.types";
import type { AppSymbolName } from "../../components/AppSymbol";

interface ReviewHeaderPresentation {
  readonly title: string;
  readonly subtitle: string;
  readonly gitMenu: ScreenHeaderMenu | null;
  readonly menuIcon: AppSymbolName;
  readonly refreshAction?: ScreenHeaderMenuItem;
}

export function useReviewHeaderPresentation(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly title: string;
  readonly subtitle: string;
  readonly androidSubtitle: string;
  readonly selectedThreadCwd: string | null;
  readonly selectedSection: ReviewSectionItem | null;
  readonly onRefresh: () => Promise<void>;
}): ReviewHeaderPresentation {
  const { selectedThread } = useThreadSelection();
  const gitState = useSelectedThreadGitState();
  const gitActions = useSelectedThreadGitActions();
  const isFocused = useIsFocused();
  const gitStatusQuery = useMobileGitStatus({
    active: true,
    focused: isFocused,
    platform: Platform.OS,
    route: { environmentId: String(props.environmentId), threadId: String(props.threadId) },
    selected:
      selectedThread === null
        ? null
        : {
            environmentId: selectedThread.environmentId,
            threadId: selectedThread.id,
            cwd: props.selectedThreadCwd,
          },
    surface: "review",
  });
  // The selection-based git hooks only apply when this review belongs to the
  // selected thread (it always does when reached from the thread's toolbar).
  const gitMenuAvailable =
    selectedThread !== null &&
    String(selectedThread.environmentId) === String(props.environmentId) &&
    String(selectedThread.id) === String(props.threadId);
  const gitMenu = useThreadGitMenuDefinition({
    environmentId: props.environmentId,
    threadId: props.threadId,
    gitCwd: props.selectedThreadCwd,
    currentBranch: selectedThread?.branch ?? null,
    gitStatus: gitStatusQuery.data,
    gitOperationLabel: gitState.gitOperationLabel,
    onPull: gitActions.onPullSelectedThreadBranch,
    onRunAction: gitActions.onRunSelectedThreadGitAction,
  });
  return {
    title: props.title,
    subtitle: props.subtitle,
    menuIcon: "ellipsis",
    gitMenu: gitMenuAvailable ? gitMenu : null,
  };
}
