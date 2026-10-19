import type {
  CredentialCaller,
  CredentialExecInput,
  CredentialExecution,
} from "@t3tools/contracts";
export function executeManualCredential(options: {
  runtime: string;
  workerEntrypoint: ReadonlyArray<string>;
  origin: CredentialCaller;
  input: CredentialExecInput;
  login: { readonly username: string; readonly password: string };
  consumerEnvironment: { readonly CB_BROWSER_ENDPOINT: string };
  signal?: AbortSignal;
}): Promise<CredentialExecution>;
