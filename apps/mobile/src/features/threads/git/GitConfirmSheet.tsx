import { resolveDefaultBranchActionDialogCopy } from "@t3tools/client-runtime/state/vcs";
import { sourceControlClients } from "@t3tools/client-runtime/source-control-clients";
import { resolveAutoFeatureBranchName } from "@t3tools/shared/git";
import * as Arr from "effect/Array";
import * as Result from "effect/Result";
import {
  StackActions,
  useIsFocused,
  useNavigation,
  type StaticScreenProps,
} from "@react-navigation/native";
import { useCallback, useMemo } from "react";
import { Platform, View } from "react-native";

import { useMobileGitStatus } from "../../../state/queries";
import { SheetHeader } from "../../../components/ui/SheetHeader";
import { FitSheet } from "../../../components/ui/FitSheet";
import { SheetIntro } from "../../../components/ui/SheetIntro";
import { useThreadSelection } from "../../../state/use-thread-selection";
import { useSelectedThreadGitActions } from "../../../state/use-selected-thread-git-actions";

import { useSelectedThreadWorktree } from "../../../state/use-selected-thread-worktree";
import {
  canRunConfirmedGitAction,
  parseDefaultBranchConfirmableAction,
  runAfterSuccessfulBranchCreation,
} from "./git-confirm-action";
import { SheetActionButton } from "./gitSheetComponents";

type GitConfirmSheetProps = StaticScreenProps<{
  readonly environmentId: string;
  readonly threadId: string;
  readonly confirmAction?: string;
  readonly branchName?: string;
  readonly cwd?: string;
  readonly includesCommit?: string;
  readonly commitMessage?: string;
  readonly filePaths?: string;
}>;

export function GitConfirmSheet(props: GitConfirmSheetProps) {
  const navigation = useNavigation();
  const isFocused = useIsFocused();
  const { selectedThread } = useThreadSelection();
  const { selectedThreadCwd } = useSelectedThreadWorktree();
  const { selectedThreadProject } = useThreadSelection();
  const terminology = sourceControlClients.get(
    selectedThreadProject?.repositoryIdentity?.provider,
  ).changeRequest;

  const params = props.route.params;

  const confirmAction = parseDefaultBranchConfirmableAction(params.confirmAction);
  const branchName = params.branchName ?? "";
  const expectedCwd = params.cwd ?? "";
  const includesCommit = params.includesCommit === "true";
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
  const gitActions = useSelectedThreadGitActions({ active: gitStatus.target !== null });
  const { canWriteSourceControl, canChangeThreadBranch } = gitActions;
  const confirmationReady = canRunConfirmedGitAction({
    confirmAction,
    expectedBranch: branchName,
    expectedCwd,
    currentCwd: selectedThreadCwd,
    status: gitStatus.data,
  });

  const copy = useMemo(
    () =>
      confirmAction
        ? resolveDefaultBranchActionDialogCopy({
            action: confirmAction,
            branchName,
            includesCommit,
            terminology,
          })
        : null,
    [branchName, confirmAction, includesCommit, terminology],
  );

  const continuePendingAction = useCallback(async () => {
    if (!canWriteSourceControl || !confirmAction || !confirmationReady) return;
    navigation.dispatch(StackActions.replace("Thread", { environmentId, threadId }));
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
    navigation,
    threadId,
  ]);

  const movePendingActionToFeatureBranch = useCallback(async () => {
    if (!canChangeThreadBranch || !confirmAction || !confirmationReady) return;
    navigation.dispatch(StackActions.replace("Thread", { environmentId, threadId }));

    if (includesCommit) {
      await gitActions.onRunSelectedThreadGitAction({
        action: confirmAction,
        featureBranch: true,
        ...(params.commitMessage ? { commitMessage: params.commitMessage } : {}),
        ...(params.filePaths ? { filePaths: params.filePaths.split(",") } : {}),
      });
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
      createBranch: () => gitActions.onCreateSelectedThreadBranch(newBranchName),
      runAction: () => gitActions.onRunSelectedThreadGitAction({ action: confirmAction }),
    });
  }, [
    canChangeThreadBranch,
    confirmAction,
    confirmationReady,
    gitActions,
    includesCommit,
    params,
    navigation,
    environmentId,
    threadId,
  ]);

  return (
    <FitSheet
      header={<SheetHeader title="Confirm action" onClose={() => navigation.goBack()} />}
      showsVerticalScrollIndicator={false}
    >
      <SheetIntro
        eyebrow="Confirm"
        title={copy?.title ?? "Run action on default branch?"}
        description={copy?.description ?? "Choose how to continue."}
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
          disabled={!canChangeThreadBranch || !confirmationReady}
          tone="primary"
          onPress={() => void movePendingActionToFeatureBranch()}
        />
      </View>
    </FitSheet>
  );
}
