import type { ConfirmDialogRequest } from "./ConfirmDialog.types";

export interface MaterialConfirmDialogProps {
  readonly request: Pick<
    ConfirmDialogRequest,
    "title" | "message" | "cancelText" | "confirmText" | "destructive" | "options"
  >;
  readonly options?: Readonly<Record<string, boolean>>;
  readonly onOptionChange?: (id: string, checked: boolean) => void;
  readonly inputInitialValue?: string;
  readonly onInputChange?: (value: string) => void;
  readonly confirmDisabled?: boolean;
  readonly onCancel: () => void;
  readonly onConfirm: (inputValue?: string) => void;
}

export function MaterialConfirmDialog(_props: MaterialConfirmDialogProps) {
  return null;
}
