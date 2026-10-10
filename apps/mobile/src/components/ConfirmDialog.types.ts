export type ConfirmDialogRequest = {
  readonly title: string;
  readonly message?: string;
  readonly cancelText?: string;
  readonly confirmText: string;
  readonly destructive?: boolean;
  readonly options?: ReadonlyArray<{
    readonly id: string;
    readonly label: string;
    readonly defaultChecked: boolean;
  }>;
  readonly onConfirm: (options: Readonly<Record<string, boolean>>) => void;
  readonly onCancel?: () => void;
};

export type TextInputDialogRequest = {
  readonly title: string;
  readonly initialValue: string;
  readonly cancelText?: string;
  readonly confirmText: string;
  readonly onConfirm: (value: string) => void;
  readonly onCancel?: () => void;
};
