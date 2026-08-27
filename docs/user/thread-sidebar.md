# Organizing threads

Pin a thread from its context menu to keep it in the pinned section above your active work.
Pinned threads are shown independently of their project, including when you connect to more than
one environment.

Pinned threads still move to **Settled** when they become inactive. They also move when their pull
request merges if **Auto-settle merged threads** is enabled.

On web and desktop, drag a pinned thread to change its position. On mobile, open the thread's menu
and choose **Move up** or **Move down**. The order is stored by the server and appears on your
other connected devices.

If reordering is unavailable for one environment, update the T3 Code server running in that
environment. Older servers can still pin and unpin threads, but do not understand synced ordering;
their pinned threads keep the default newest-first order below the ones you have arranged.

Thread titles are bright when a new assistant message has arrived since you last opened the thread,
including messages sent while the agent is still working. Opening the thread marks that message as
read. Tool activity does not make a title bright.

## Environment artwork

Dev and Nightly environments can identify themselves with artwork at the top of the sidebar and in
the send button. Choose **Artwork**, **Version pill**, or **None** in Settings under environment
identification. Artwork is recolored to match each built-in theme. Custom themes use the **Version
pill** fallback because their colors are not controlled by T3 Code.

To generate a fresh title from the conversation, open a thread's context menu and choose
**Regenerate title**. While T3 Code is generating it, the action reads **Regenerating…** and cannot
be selected again. The option is hidden when the connected environment needs a server update.

## Completion attention

T3 Code can play a short chime when a session finishes with a completion you have not seen. The
desktop app also shows the number of these completed threads on its dock or taskbar icon. Opening a
thread marks its completion as seen and reduces the count.

Use **Settings → General** to turn **Session finish sound** or **App icon unread badge** on or off.
The app-icon badge is desktop-only. Mobile completion sounds and badges continue to come from
system push notifications.
