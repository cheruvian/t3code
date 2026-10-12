const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld(
  "brokerDesktop",
  Object.freeze({
    model: () => ipcRenderer.invoke("desktop:model"),
    act: (action, value) => ipcRenderer.invoke("desktop:action", action, value),
    ready: () => ipcRenderer.send("desktop:visible"),
    subscribe: (callback) => {
      const listener = (_event, value) => callback(value);
      ipcRenderer.on("desktop:model", listener);
      return () => ipcRenderer.removeListener("desktop:model", listener);
    },
  }),
);
