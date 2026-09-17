import { resolveDefaultBranchActionDialogCopy } from "@t3tools/client-runtime/state/vcs";
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
import { Platform, ScrollView, useWindowDimensions, View } from "react-native";

import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AndroidSheetHeader } from "../../../components/AndroidScreenHeader";
import { MaterialScreenContent } from "../../../components/MaterialScreenContent";
import { NativeStackScreenOptions } from "../../../native/StackHeader";
import { AppText as Text } from "../../../components/AppText";
import { useMobileGitStatus } from "../../../state/queries";
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
  const insets = useSafeAreaInsets();
  const { selectedThread } = useThreadSelection();
  const { selectedThreadCwd } = useSelectedThreadWorktree();
  const { height: windowHeight } = useWindowDimensions();
  const gitActions = useSelectedThreadGitActions();

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
          })
        : null,
    [branchName, confirmAction, includesCommit],
  );

  const continuePendingAction = useCallback(async () => {
    if (!confirmAction || !confirmationReady) return;
    navigation.dispatch(StackActions.replace("Thread", { environmentId, threadId }));
    await gitActions.onRunSelectedThreadGitAction({
      action: confirmAction,
      ...(params.commitMessage ? { commitMessage: params.commitMessage } : {}),
      ...(params.filePaths ? { filePaths: params.filePaths.split(",") } : {}),
    });
  }, [confirmAction, confirmationReady, environmentId, gitActions, params, navigation, threadId]);

  const movePendingActionToFeatureBranch = useCallback(async () => {
    if (!confirmAction || !confirmationReady) return;
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
    <View
      collapsable={false}
      className={Platform.OS === "android" ? "bg-sheet" : "flex-1 bg-sheet"}
      style={Platform.OS === "android" ? { maxHeight: windowHeight * 0.92 } : undefined}
    >
      {Platform.OS === "android" ? (
        <NativeStackScreenOptions
          options={{
            sheetCornerRadius: 28,
            sheetAllowedDetents: "fitToContents",
          }}
        />
      ) : null}
      {Platform.OS === "android" ? (
        <AndroidSheetHeader
          title="Confirm action"
          onBack={() => navigation.goBack()}
          hideBottomBorder
        />
      ) : (
        <View className="min-h-4 pt-2" />
      )}

      <MaterialScreenContent fitToContents>
        <ScrollView
          className={Platform.OS === "android" ? "shrink grow-0" : "flex-1"}
          showsVerticalScrollIndicator={false}
          contentContainerClassName={Platform.OS === "android" ? "gap-2 p-2" : undefined}
          contentContainerStyle={
            Platform.OS === "android"
              ? { paddingBottom: Math.max(insets.bottom, 18) + 8 }
              : undefined
          }
        >
          <View
            className={
              Platform.OS === "android"
                ? "gap-2 rounded-[20px] bg-card p-3"
                : "items-center gap-1 px-5 pb-3 pt-4"
            }
          >
            {Platform.OS !== "android" ? (
              <Text className="text-xs font-t3-bold tracking-[1px] uppercase text-foreground-muted">
                Confirm
              </Text>
            ) : null}
            <Text
              className={
                Platform.OS === "android"
                  ? "text-xl font-t3-medium"
                  : "text-center text-3xl font-t3-bold"
              }
            >
              {copy?.title ?? "Run action on default branch?"}
            </Text>
            <Text
              className={
                Platform.OS === "android"
                  ? "text-foreground-secondary text-base leading-normal"
                  : "text-center text-foreground-secondary text-sm font-medium leading-normal"
              }
            >
              {copy?.description ?? "Choose how to continue."}
            </Text>
          </View>

          <View
            className={Platform.OS === "android" ? "gap-2" : "gap-3 px-5 pt-2"}
            style={
              Platform.OS === "android"
                ? undefined
                : { paddingBottom: Math.max(insets.bottom, 18) + 8 }
            }
          >
            <SheetActionButton
              icon="arrow.right.circle"
              label={copy?.continueLabel ?? "Continue"}
              disabled={!confirmationReady}
              onPress={() => void continuePendingAction()}
            />
            <SheetActionButton
              icon="arrow.branch"
              label="Feature branch & continue"
              disabled={!confirmationReady}
              tone="primary"
              onPress={() => void movePendingActionToFeatureBranch()}
            />
          </View>
        </ScrollView>
      </MaterialScreenContent>
    </View>
  );
}
