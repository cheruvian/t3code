import { describe, expect, it, vi } from "vite-plus/test";
import {
  assertCredentialEntryInactive,
  closeCredentialEntry,
  closeCredentialPeer,
  credentialEntryActive,
  credentialEntryEpoch,
  setCredentialEntryPrivacy,
} from "./CredentialEntryPrivacy.ts";

const fixture = (id: number) => {
  const ack = Promise.withResolvers<boolean>();
  let destroyed = false;
  let onDestroyed = () => {};
  const close = vi.fn(() => {
    destroyed = true;
    onDestroyed();
  });
  const executeJavaScript = vi.fn(() => ack.promise);
  const guest = {
    id,
    session: {},
    close,
    once: (_name: string, callback: () => void) => {
      onDestroyed = callback;
    },
    isDestroyed: () => destroyed,
    hostWebContents: { isDestroyed: () => false, executeJavaScript },
  } as unknown as Electron.WebContents;
  return { guest, ack, close, executeJavaScript };
};

describe("desktop credential privacy", () => {
  it("blocks capture before waiting for renderer acknowledgement, and restores only after release acknowledgement", async () => {
    const f = fixture(301);
    const before = credentialEntryEpoch(f.guest.id);
    const pending = setCredentialEntryPrivacy(f.guest, true, async () => true);
    expect(credentialEntryActive(301)).toBe(true);
    expect(() => assertCredentialEntryInactive(301)).toThrow();
    expect(credentialEntryEpoch(301)).toBeGreaterThan(before);
    f.ack.resolve(true);
    await pending;
    const release = Promise.withResolvers<boolean>();
    f.executeJavaScript.mockImplementation(() => release.promise);
    const released = setCredentialEntryPrivacy(f.guest, false, undefined);
    expect(credentialEntryActive(301)).toBe(true);
    release.resolve(true);
    await released;
    expect(credentialEntryActive(301)).toBe(false);
    expect(f.close).not.toHaveBeenCalled();
  });
  it.each([false, true])(
    "closes rather than revealing a page if renderer or active recording prevents protection (%s)",
    async (canEnter) => {
      const f = fixture(canEnter ? 302 : 303);
      f.ack.resolve(false);
      await expect(setCredentialEntryPrivacy(f.guest, true, async () => canEnter)).rejects.toThrow(
        "privacy is unavailable",
      );
      expect(f.close).toHaveBeenCalledOnce();
      expect(credentialEntryActive(f.guest.id)).toBe(false);
    },
  );
  it("destroys a protected guest if its server disconnects", async () => {
    const f = fixture(304);
    f.ack.resolve(true);
    await setCredentialEntryPrivacy(f.guest, true, async () => true);
    closeCredentialEntry(f.guest);
    expect(f.close).toHaveBeenCalledOnce();
    expect(credentialEntryActive(304)).toBe(false);
  });
});

it("closes newly created sibling pages in a protected session, without touching another session", async () => {
  const f = fixture(305);
  f.ack.resolve(true);
  await setCredentialEntryPrivacy(f.guest, true, async () => true);
  const close = vi.fn();
  const peer = {
    session: f.guest.session,
    isDestroyed: () => false,
    close,
  } as unknown as Electron.WebContents;
  closeCredentialPeer(peer);
  expect(close).toHaveBeenCalledOnce();
  const unrelated = {
    session: {},
    isDestroyed: () => false,
    close: vi.fn(),
  } as unknown as Electron.WebContents;
  closeCredentialPeer(unrelated);
  expect(unrelated.close).not.toHaveBeenCalled();
  await setCredentialEntryPrivacy(f.guest, false, undefined);
  close.mockClear();
  closeCredentialPeer(peer);
  expect(close).not.toHaveBeenCalled();
});
