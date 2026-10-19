import type {
  CredentialBrokerState,
  CredentialBrokerAction,
  CredentialCaller,
  CredentialExecInput,
  CredentialExecution,
} from "@t3tools/contracts";
export class T3CredentialBroker {
  constructor(options: { runtime: string; workerEntrypoint?: ReadonlyArray<string> });
  state(): CredentialBrokerState;
  subscribe(
    sessionId: string,
    viewId: string,
    listener: (state: CredentialBrokerState) => void,
  ): () => void;
  action(sessionId: string, input: CredentialBrokerAction): Promise<void>;
  execute(
    origin: CredentialCaller,
    input: CredentialExecInput,
    signal?: AbortSignal,
    consumerEnvironment?: { readonly CB_BROWSER_ENDPOINT: string },
  ): Promise<CredentialExecution>;
  cancelCall(toolCallId: string): Promise<void>;
  cancelSession(providerSessionId: string): Promise<void>;
  close(): Promise<void>;
}
