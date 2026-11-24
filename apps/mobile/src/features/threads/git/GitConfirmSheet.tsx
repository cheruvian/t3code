import { resolveDefaultBranchActionDialogCopy } from "@t3tools/client-runtime/state/vcs";
import { sourceControlClients } from "@t3tools/client-runtime/source-control-clients";
import { resolveAutoFeatureBranchName } from "@t3tools/shared/git";
import * as Arr from "effect/Array";
import * as Result from "effect/Result";
import { useNavigation, type StaticScreenProps, useIsFocused } from "@react-navigation/native";
import { useGT, useMessages } from "gt-react-native";
import { useCallback, useMemo } from "react";
import { Platform, View } from "react-native";

import { useMobileGitStatus } from "../../../state/queries";
import { SheetHeader } from "../../../components/ui/SheetHeader";
import { FitSheet } from "../../../components/ui/FitSheet";
import { SheetIntro } from "../../../components/ui/SheetIntro";
import {
  gitRepositoryTargetFromRoute,
  type GitRepositoryRouteParams,
} from "../../../state/thread-git-target";
import { useReturnToThread } from "../thread-inspector-navigation";
import { useThreadSelection } from "../../../state/use-thread-selection";
import { useSelectedThreadGitActions } from "../../../state/use-selected-thread-git-actions";

import { useSelectedThreadWorktree } from "../../../state/use-selected-thread-worktree";
import {
  canRunConfirmedGitAction,
  parseDefaultBranchConfirmableAction,
  runAfterSuccessfulBranchCreation,
} from "./git-confirm-action";
import { SheetActionButton } from "./gitSheetComponents";

type GitConfirmSheetProps = StaticScreenProps<
  {
    readonly environmentId: string;
    readonly threadId: string;
    readonly confirmAction?: string;
    readonly branchName?: string;
    readonly cwd?: string;
    readonly includesCommit?: string;
    readonly commitMessage?: string;
    readonly filePaths?: string;
  } & GitRepositoryRouteParams
>;

export function GitConfirmSheet(props: GitConfirmSheetProps) {
  const gt = useGT();
  const messages = useMessages();
  const navigation = useNavigation();
  const isFocused = useIsFocused();
  const returnToThread = useReturnToThread();
  const repository = gitRepositoryTargetFromRoute(props.route.params);
  const { selectedThread, selectedThreadProject } = useThreadSelection();
  const threadWorktree = useSelectedThreadWorktree();
  const selectedThreadCwd = repository?.cwd ?? threadWorktree.selectedThreadCwd;
  const params = props.route.params;

  const confirmAction = parseDefaultBranchConfirmableAction(params.confirmAction);
  const branchName = params.branchName ?? "";
  const expectedCwd = params.cwd ?? "";
  const includesCommit = confirmAction === "commit_push" || confirmAction === "commit_push_pr";
  const environmentId = params.environmentId ?? "";
  const threadId = params.threadId ?? "";
  const gitStatus = useMobileGitStatus({
    active:
      confirmAction !== null &&
      branchName.length > 0 &&
      selectedThreadCwd?.trim() === expectedCwd.trim(),
    focused: isFocused,
    platform: Platform.OS,
    route: params,
    selected:
      selectedThread === null
        ? null
        : {
            environmentId: selectedThread.environmentId,
            threadId: selectedThread.id,
            cwd: selectedThreadCwd,
          },
    surface: "confirm",
  });
  const gitActions = useSelectedThreadGitActions(repository, { active: gitStatus.target !== null });
  const { canWriteSourceControl, canCreateFeatureBranch } = gitActions;
  const confirmationReady = canRunConfirmedGitAction({
    confirmAction,
    expectedBranch: branchName,
    expectedCwd,
    currentCwd: selectedThreadCwd,
    status: gitStatus.data,
  });

  const terminology = sourceControlClients.get(
    repository === undefined
      ? selectedThreadProject?.repositoryIdentity?.provider
      : gitStatus.data?.sourceControlProvider?.kind,
  ).changeRequest;

  const copy = useMemo(
    () =>
      confirmAction && branchName
        ? resolveDefaultBranchActionDialogCopy(
            {
              action: confirmAction,
              branchName,
              includesCommit,
              terminology,
            },
            messages,
          )
        : null,
    [branchName, confirmAction, includesCommit, messages, terminology],
  );

  const continuePendingAction = useCallback(async () => {
    if (!canWriteSourceControl || !confirmAction || !confirmationReady) return;
    returnToThread({ environmentId, threadId });
    await gitActions.onRunSelectedThreadGitAction({
      action: confirmAction,
      ...(params.commitMessage ? { commitMessage: params.commitMessage } : {}),
      ...(params.filePaths ? { filePaths: params.filePaths.split(",") } : {}),
    });
  }, [
    canWriteSourceControl,
    confirmAction,
    confirmationReady,
    environmentId,
    gitActions,
    params,
    returnToThread,
    threadId,
  ]);

  const movePendingActionToFeatureBranch = useCallback(async () => {
    if (!canCreateFeatureBranch || !confirmAction || !confirmationReady) return;
    returnToThread({ environmentId, threadId });

    if (includesCommit) {
      await gitActions.onRunSelectedThreadGitAction({ action: confirmAction, featureBranch: true });
      return;
    }

    const branches = await gitActions.refreshSelectedThreadBranches();
    if (branches === null) return;
    const newBranchName = resolveAutoFeatureBranchName(
      Arr.filterMap(branches, (branch) =>
        branch.isRemote ? Result.failVoid : Result.succeed(branch.name),
      ),
    );
    await runAfterSuccessfulBranchCreation({
      createBranch: async () =>
        (await gitActions.onCreateSelectedThreadBranch(newBranchName)) !== null,
      runAction: () => gitActions.onRunSelectedThreadGitAction({ action: confirmAction }),
    });
  }, [
    canCreateFeatureBranch,
    confirmAction,
    confirmationReady,
    gitActions,
    includesCommit,
    returnToThread,
    environmentId,
    threadId,
  ]);

  return (
    <FitSheet
      header={<SheetHeader title={gt("Confirm action")} onClose={() => navigation.goBack()} />}
      showsVerticalScrollIndicator={false}
    >
      <SheetIntro
        eyebrow={gt("Confirm", { $context: "eyebrow label above a confirmation title" })}
        title={copy?.title ?? gt("Run action on default branch?")}
        description={copy?.description ?? gt("Choose how to continue.")}
      />

      <View className="gap-3">
        <SheetActionButton
          icon="arrow.right.circle"
          label={copy?.continueLabel ?? "Continue"}
          disabled={!canWriteSourceControl || !confirmationReady}
          onPress={() => void continuePendingAction()}
        />
        <SheetActionButton
          icon="arrow.branch"
          label="Feature branch & continue"
          disabled={!canCreateFeatureBranch || !confirmationReady}
          tone="primary"
          onPress={() => void movePendingActionToFeatureBranch()}
        />
      </View>
    </FitSheet>
  );
}
