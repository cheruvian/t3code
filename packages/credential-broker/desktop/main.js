import {
  app,
  BrowserWindow,
  ipcMain,
  protocol,
  net,
  session,
  screen,
  Tray,
  Menu,
  nativeImage,
} from "electron";
import { fileURLToPath, pathToFileURL } from "node:url";
import { join } from "node:path";
import { createInterface } from "node:readline";

// Presenter faults terminate safely instead of opening a blocking error dialog.
process.on("uncaughtException", () => app.exit(1));
process.on("unhandledRejection", () => app.exit(1));
app.setName("Credential Broker");
protocol.registerSchemesAsPrivileged([
  {
    scheme: "broker",
    privileges: { standard: true, secure: true, supportFetchAPI: true },
  },
]);
const root = fileURLToPath(new URL(".", import.meta.url));
const windows = new Map();
const notices = new Map();
const pending = new Map();
let dashboard, tray;
let state = { status: "starting", grants: [], requests: [], runtime: "" };
let quitting = false;
const emit = (value) => process.stdout.write(JSON.stringify(value) + "\n");
const respond = (id, value) => emit({ event: "response", id, value });

function trusted(event) {
  const record = windows.get(event.sender.id);
  if (
    !record ||
    event.senderFrame !== event.sender.mainFrame ||
    event.senderFrame.url !== "broker://desktop/index.html"
  )
    throw new Error("Untrusted desktop sender.");
  return record;
}
function publish(record) {
  record.model.revision = (record.model.revision ?? 0) + 1;
  if (!record.window.isDestroyed()) record.window.webContents.send("desktop:model", record.model);
}
function createWindow(model, options = {}) {
  const win = new BrowserWindow({
    width: 560,
    height: Math.min(780, screen.getPrimaryDisplay().workArea.height - 60),
    show: false,
    resizable: false,
    backgroundColor: "#111118",
    title: "Credential Broker",
    titleBarStyle: "hiddenInset",
    autoHideMenuBar: true,
    ...options,
    webPreferences: {
      preload: join(root, "preload.cjs"),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      devTools: false,
      partition: "desktop-private",
    },
  });
  model.revision = 0;
  const record = { window: win, model };
  const contentsId = win.webContents.id;
  windows.set(contentsId, record);
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  win.webContents.on("will-navigate", (event) => event.preventDefault());
  win.webContents.on("render-process-gone", () => {
    if (model.type === "notice") emit({ event: "revoke", notice_id: model.data.notice_id });
    win.destroy();
  });
  win.on("closed", () => {
    windows.delete(contentsId);
    if (model.type === "notice") {
      notices.delete(model.data.notice_id);
      if (!quitting && !record.expectedClose)
        emit({ event: "revoke", notice_id: model.data.notice_id });
      arrangeNotices();
    }
    if (model.id && pending.has(model.id)) {
      pending.delete(model.id);
      respond(model.id, { approve: false });
    }
  });
  void win.loadURL("broker://desktop/index.html");
  return record;
}
function arrangeNotices() {
  const area = screen.getPrimaryDisplay().workArea;
  let bottom = area.y + 20;
  for (const record of notices.values()) {
    record.window.setPosition(area.x + area.width - 420 - 20, bottom);
    bottom += 254;
  }
}
function hideNotice(id) {
  const record = notices.get(id);
  if (record) {
    record.expectedClose = true;
    record.window.close();
  }
}
function showDashboard() {
  if (!dashboard || dashboard.window.isDestroyed()) {
    dashboard = createWindow(
      { type: "dashboard", data: state },
      {
        width: 740,
        height: 740,
        resizable: true,
        minWidth: 560,
        minHeight: 500,
      },
    );
    dashboard.window.on("close", (event) => {
      if (!quitting) {
        event.preventDefault();
        dashboard.window.hide();
      }
    });
  } else {
    dashboard.window.show();
    dashboard.window.focus();
  }
}

ipcMain.handle("desktop:model", (event) => trusted(event).model);
ipcMain.on("desktop:visible", (event) => {
  const record = trusted(event);
  if (record.model.type === "notice") record.window.showInactive();
  else {
    record.window.show();
    record.window.focus();
  }
  if (record.model.type === "notice" && record.model.id) {
    respond(record.model.id, true);
    record.model.id = undefined;
  }
});
ipcMain.handle("desktop:action", (event, action, value) => {
  const record = trusted(event);
  const { model } = record;
  if (model.type === "approval" && ["deny", "once", "always"].includes(action)) {
    const candidates = model.data.candidates ?? [{ item_id: model.data.item_id }];
    if (
      action !== "deny" &&
      (!candidates.some((c) => c.item_id === value) ||
        (action === "always" && model.data.kind !== "exec"))
    )
      throw new Error("Invalid approval selection.");
    if (!pending.delete(model.id)) throw new Error("Approval expired.");
    respond(model.id, {
      approve: action !== "deny",
      always: action === "always",
      item_id: action === "deny" ? undefined : value,
    });
    record.window.close();
    return true;
  }
  if (model.type === "unlock" && ["unlock", "deny"].includes(action)) {
    if (action === "unlock" && (typeof value !== "string" || !value || value.length > 4096))
      throw new Error("Invalid unlock.");
    if (!pending.delete(model.id)) throw new Error("Unlock expired.");
    respond(model.id, action === "unlock" ? { password: value } : {});
    record.window.close();
    return true;
  }
  if (model.type === "notice" && ["revoke", "dismiss"].includes(action)) {
    emit({ event: action, notice_id: model.data.notice_id });
    if (action === "dismiss") hideNotice(model.data.notice_id);
    return true;
  }
  if (model.type === "dashboard" && ["revoke", "release"].includes(action)) {
    const list = action === "revoke" ? state.grants : state.requests;
    const key = action === "revoke" ? "grant_id" : "request_id";
    if (!list.some((entry) => entry[key] === value)) throw new Error("Unknown access.");
    emit({ event: "manage", action, id: value });
    return true;
  }
  throw new Error("Action unavailable in this window.");
});

app
  .whenReady()
  .then(() => {
    const privateSession = session.fromPartition("desktop-private");
    privateSession.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
    privateSession.setPermissionCheckHandler(() => false);
    privateSession.webRequest.onBeforeRequest((details, callback) =>
      callback({ cancel: !details.url.startsWith("broker://desktop/") }),
    );
    privateSession.protocol.handle("broker", (request) => {
      const url = new URL(request.url);
      const name = url.pathname.slice(1);
      if (url.hostname !== "desktop" || !["index.html", "style.css", "renderer.js"].includes(name))
        return new Response("", { status: 404 });
      return net.fetch(pathToFileURL(join(root, name)).href);
    });
    const icon = nativeImage.createFromDataURL(
      "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAABGUlEQVQ4T6WTMQ7CMAxFrYgFMQEYGNhYWHsAJBYkLkAOwBG4AkfACbgAAysDAyOx8AjMDCwIjEKrTJRFErXSpH/q2P9/J48TMmOCME2TGO5L2C46P/vO3Hc/JhkQEXEWUYBtfEpEUFDgJ7hx+gzYs/QVAfSoCJYP8DeujKuLHoaIKIJbTOImNLdqVvIFGFtv2HyvZZEDZhLWbpuAMcxCYIyfAtJo9fgTLFGtOApgSWAMk+bNhj+BPRQQcMmzJrULmAYVdWSWrSBkrQoCg0YZvyNx4LrnOgSqPrZaRcgixdywsIDpqMqKO74XD9EoiUQIVvlWO//feUPsBW97KNpFgBffHLDS8TZgjOfpkZwCd2DOMwZiUepmtqlkgE+BQiijBJCDMcAAAAASUVORK5CYII=",
    );
    icon.setTemplateImage(true);
    tray = new Tray(icon);
    tray.setToolTip("Credential Broker");
    tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: "Permissions & activity", click: showDashboard },
        { type: "separator" },
        {
          label: "Lock vault & quit",
          click: () => emit({ event: "manage", action: "quit" }),
        },
      ]),
    );
    tray.on("click", showDashboard);
    app.on("activate", showDashboard);
    app.on("window-all-closed", () => {});
    app.on("before-quit", (event) => {
      if (!quitting) {
        event.preventDefault();
        emit({ event: "manage", action: "quit" });
      }
    });
    const lines = createInterface({ input: process.stdin });
    lines.on("line", (line) => {
      if (line.length > 131072) return;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        return;
      }
      const { command, id, payload } = message;
      if (command === "ready") return respond(id, true);
      if (["approve", "unlock"].includes(command)) {
        const record = createWindow(
          {
            type: command === "approve" ? "approval" : "unlock",
            id,
            data: payload,
          },
          command === "unlock" ? { height: 480 } : {},
        );
        pending.set(id, record);
        return;
      }
      if (command === "cancel") {
        const record = pending.get(id);
        pending.delete(id);
        record?.window.close();
        return;
      }
      if (command === "notice") {
        if (
          notices.size >=
          Math.max(1, Math.floor((screen.getPrimaryDisplay().workArea.height - 40) / 254))
        )
          return respond(id, false);
        payload.expires_at = Date.now() + 300000;
        const record = createWindow(
          { type: "notice", id, data: payload },
          {
            width: 420,
            height: 234,
            frame: false,
            titleBarStyle: "default",
            alwaysOnTop: true,
            skipTaskbar: true,
            focusable: false,
          },
        );
        record.window.setVisibleOnAllWorkspaces(true, {
          visibleOnFullScreen: true,
        });
        notices.set(payload.notice_id, record);
        arrangeNotices();
        return;
      }
      if (command === "update") {
        const record = notices.get(payload.notice_id);
        if (record) {
          record.model.data = payload;
          publish(record);
        }
        return;
      }
      if (command === "dismiss") return hideNotice(message.notice_id);
      if (command === "state") {
        state = payload;
        if (!dashboard && state.status === "ready") showDashboard();
        if (dashboard && !dashboard.window.isDestroyed()) {
          dashboard.model.data = state;
          publish(dashboard);
        }
      }
    });
    lines.on("close", () => {
      quitting = true;
      app.quit();
    });
    setInterval(() => {
      for (const [id, record] of notices)
        if (Date.now() >= record.model.data.expires_at) hideNotice(id);
    }, 250).unref();
  })
  .catch(() => {
    process.exitCode = 1;
    app.exit(1);
  });
