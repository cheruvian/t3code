import { describe, expect, it } from "vite-plus/test";
import { credentialDialogAttentionKey, reconcileCredentialDialog } from "./credentialBroker.ts";

const thread = { environmentId: "one", threadId: "blocked" };
const other = { environmentId: "one", threadId: "important" };
const request = { requestId: "approval", origin: thread };
const keyFor = (view: typeof thread | null) => credentialDialogAttentionKey([request], "one", view);
const initial = { viewKey: JSON.stringify(other), attentionKey: null, open: false };

describe("credential request presentation", () => {
  it("does not interrupt another thread, and opens on the blocked thread", () => {
    expect(keyFor(other)).toBeNull();
    expect(keyFor(null)).toBeNull();
    const shown = reconcileCredentialDialog(initial, JSON.stringify(thread), keyFor(thread));
    expect(shown.open).toBe(true);
  });

  it("stays hidden as account search updates, then reopens on a return visit", () => {
    const shown = reconcileCredentialDialog(initial, JSON.stringify(thread), keyFor(thread));
    const hidden = { ...shown, open: false };
    expect(reconcileCredentialDialog(hidden, JSON.stringify(thread), keyFor(thread))).toBe(hidden);
    const away = reconcileCredentialDialog(hidden, JSON.stringify(other), keyFor(other));
    expect(away.open).toBe(false);
    const returned = reconcileCredentialDialog(away, JSON.stringify(thread), keyFor(thread));
    expect(returned.open).toBe(true);
  });

  it("keeps completion visible when already open, without reopening a hidden dialog", () => {
    const shown = reconcileCredentialDialog(initial, JSON.stringify(thread), keyFor(thread));
    expect(reconcileCredentialDialog(shown, JSON.stringify(thread), null).open).toBe(true);
    expect(
      reconcileCredentialDialog({ ...shown, open: false }, JSON.stringify(thread), null).open,
    ).toBe(false);
  });

  it("distinguishes environments and keeps unscoped external approvals reachable", () => {
    expect(keyFor({ environmentId: "two", threadId: "blocked" })).toBeNull();
    expect(credentialDialogAttentionKey([request], "two", thread)).toBeNull();
    expect(credentialDialogAttentionKey([{ requestId: "external" }], "one", other)).not.toBeNull();
  });

  it("opens for a new request in the viewed thread without treating reordering as new work", () => {
    const another = { ...request, requestId: "second" };
    const two = credentialDialogAttentionKey([request, another], "one", thread);
    expect(two).toBe(credentialDialogAttentionKey([another, request], "one", thread));
    const hidden = { viewKey: JSON.stringify(thread), attentionKey: keyFor(thread), open: false };
    expect(reconcileCredentialDialog(hidden, JSON.stringify(thread), two).open).toBe(true);
  });
});
