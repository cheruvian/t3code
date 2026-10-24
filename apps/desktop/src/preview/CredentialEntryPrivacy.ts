import { DESKTOP_PREVIEW_CREDENTIAL_ENTRY } from "@t3tools/contracts";

const epochs = new Map<number, number>();
export const credentialEntryEpoch = (id: number) => epochs.get(id) ?? 0;
const protectedGuests = new Set<number>();
const protectedSessions = new WeakMap<Electron.Session, Electron.WebContents>();
export function closeCredentialPeer(guest: Electron.WebContents) {
  if (protectedSessions.has(guest.session) && !guest.isDestroyed())
    guest.close({ waitForBeforeUnload: false });
}
export const credentialEntryActive = (id: number) => protectedGuests.has(id);
export function assertCredentialEntryInactive(id: number) {
  if (credentialEntryActive(id)) throw new Error("Private credential entry is in progress.");
}

/** The renderer acknowledgement precedes the first credential-bearing CDP command. */
export async function setCredentialEntryPrivacy(
  guest: Electron.WebContents,
  active: boolean,
  canEnter: (() => Promise<boolean>) | undefined,
) {
  const session = guest.session;
  if (active) {
    if (session && protectedSessions.has(session))
      throw new Error("Private credential entry is in progress.");
    assertCredentialEntryInactive(guest.id);
    protectedGuests.add(guest.id);
    if (session) protectedSessions.set(session, guest);
    guest.once("destroyed", () => {
      protectedGuests.delete(guest.id);
      if (session && protectedSessions.get(session) === guest) protectedSessions.delete(session);
    });
    epochs.set(guest.id, credentialEntryEpoch(guest.id) + 1);
  }
  try {
    if (active && (!canEnter || !(await canEnter()))) throw new Error();
    const host = guest.hostWebContents;
    if (!host || host.isDestroyed()) throw new Error();
    const ready = await host.executeJavaScript(
      `Promise.resolve(globalThis[${JSON.stringify(DESKTOP_PREVIEW_CREDENTIAL_ENTRY)}]?.(${guest.id}, ${active})).then(value => value === true)`,
    );
    if (!ready) throw new Error();
    if (!active) {
      protectedGuests.delete(guest.id);
      if (session && protectedSessions.get(session) === guest) protectedSessions.delete(session);
    }
  } catch {
    // A missing renderer or interrupted cleanup must never reveal a filled page.
    guest.close({ waitForBeforeUnload: false });
    throw new Error("Browser credential privacy is unavailable.");
  }
}

export function closeCredentialEntry(guest: Electron.WebContents) {
  if (!credentialEntryActive(guest.id)) return;
  if (!guest.isDestroyed()) guest.close({ waitForBeforeUnload: false });
}
