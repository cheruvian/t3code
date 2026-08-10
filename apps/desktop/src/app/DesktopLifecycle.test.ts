import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";

import type * as Electron from "electron";

import * as ElectronApp from "../electron/ElectronApp.ts";
import * as ElectronTheme from "../electron/ElectronTheme.ts";
import * as DesktopEnvironment from "./DesktopEnvironment.ts";
import * as DesktopLifecycle from "./DesktopLifecycle.ts";
import * as DesktopShutdown from "./DesktopShutdown.ts";
import * as DesktopState from "./DesktopState.ts";
import * as DesktopWindow from "../window/DesktopWindow.ts";
import * as DesktopSafeShutdown from "./DesktopSafeShutdown.ts";

describe("DesktopLifecycle", () => {
  it.effect("keeps the desktop open when an interactive shutdown is cancelled", () =>
    Effect.gen(function* () {
      const appListeners = new Map<string, (...args: readonly unknown[]) => void>();
      const requested = yield* Deferred.make<void>();
      let quitCalls = 0;
      const layer = DesktopLifecycle.layer.pipe(
        Layer.provideMerge(
          Layer.succeed(DesktopSafeShutdown.DesktopSafeShutdown, {
            request: () =>
              Deferred.succeed(requested, undefined).pipe(Effect.as("cancelled" as const)),
            resolve: () => Effect.void,
          }),
        ),
        Layer.provideMerge(
          Layer.succeed(ElectronApp.ElectronApp, {
            metadata: Effect.die("unexpected metadata read"),
            name: Effect.succeed("T3 Code"),
            whenReady: Effect.void,
            quit: Effect.sync(() => {
              quitCalls += 1;
            }),
            exit: () => Effect.void,
            relaunch: () => Effect.void,
            setPath: () => Effect.void,
            setName: () => Effect.void,
            setAboutPanelOptions: () => Effect.void,
            setAppUserModelId: () => Effect.void,
            getAppMetrics: Effect.succeed([]),
            isDefaultProtocolClient: () => Effect.succeed(false),
            setAsDefaultProtocolClient: () => Effect.succeed(true),
            setDesktopName: () => Effect.void,
            setDockIcon: () => Effect.void,
            appendCommandLineSwitch: () => Effect.void,
            removeCommandLineSwitch: () => Effect.void,
            onBeforeQuitForUpdate: () => Effect.void,
            on: (eventName, listener) =>
              Effect.acquireRelease(
                Effect.sync(() => {
                  appListeners.set(eventName, listener as never);
                }),
                () =>
                  Effect.sync(() => {
                    appListeners.delete(eventName);
                  }),
              ).pipe(Effect.asVoid),
          } satisfies ElectronApp.ElectronApp["Service"]),
        ),
        Layer.provideMerge(
          Layer.succeed(ElectronTheme.ElectronTheme, {
            shouldUseDarkColors: Effect.succeed(false),
            setSource: () => Effect.void,
            onUpdated: () => Effect.void,
          }),
        ),
        Layer.provideMerge(
          Layer.succeed(DesktopWindow.DesktopWindow, {
            createMain: Effect.die("unexpected window creation"),
            ensureMain: Effect.die("unexpected window creation"),
            revealOrCreateMain: Effect.die("unexpected window creation"),
            activate: Effect.void,
            createMainIfBackendReady: Effect.void,
            showConnectingSplash: Effect.void,
            handleBackendReady: () => Effect.void,
            handleBackendNotReady: Effect.void,
            flushMainWindowBounds: Effect.void,
            dispatchMenuAction: () => Effect.void,
            syncAppearance: Effect.void,
          }),
        ),
        Layer.provideMerge(
          Layer.succeed(DesktopEnvironment.DesktopEnvironment, {
            platform: "darwin",
            isDevelopment: false,
          } as DesktopEnvironment.DesktopEnvironment["Service"]),
        ),
        Layer.provideMerge(DesktopShutdown.layer),
        Layer.provideMerge(DesktopState.layer),
      );

      yield* Effect.scoped(
        Effect.gen(function* () {
          const lifecycle = yield* DesktopLifecycle.DesktopLifecycle;
          const state = yield* DesktopState.DesktopState;
          yield* lifecycle.register;
          let prevented = false;
          appListeners.get("before-quit")?.({
            preventDefault: () => {
              prevented = true;
            },
          } as Electron.Event);
          yield* Deferred.await(requested);
          yield* Effect.yieldNow;
          assert.isTrue(prevented);
          assert.equal(quitCalls, 0);
          assert.isFalse(yield* Ref.get(state.quitting));
        }),
      ).pipe(Effect.provide(layer));
    }),
  );

  for (const platform of ["darwin", "win32", "linux"] satisfies ReadonlyArray<NodeJS.Platform>) {
    it.effect(`lets the updater's quit event proceed on ${platform}`, () => {
      const appListeners = new Map<string, (...args: readonly unknown[]) => void>();

      const electronAppLayer = Layer.succeed(ElectronApp.ElectronApp, {
        metadata: Effect.die("unexpected metadata read"),
        name: Effect.succeed("T3 Code"),
        whenReady: Effect.void,
        quit: Effect.void,
        exit: () => Effect.void,
        relaunch: () => Effect.void,
        setPath: () => Effect.void,
        setName: () => Effect.void,
        setAboutPanelOptions: () => Effect.void,
        setAppUserModelId: () => Effect.void,
        getAppMetrics: Effect.succeed([]),
        isDefaultProtocolClient: () => Effect.succeed(false),
        setAsDefaultProtocolClient: () => Effect.succeed(true),
        setDesktopName: () => Effect.void,
        setDockIcon: () => Effect.void,
        appendCommandLineSwitch: () => Effect.void,
        removeCommandLineSwitch: () => Effect.void,
        onBeforeQuitForUpdate: (listener) =>
          Effect.acquireRelease(
            Effect.sync(() => {
              appListeners.set("before-quit-for-update", listener);
            }),
            () =>
              Effect.sync(() => {
                appListeners.delete("before-quit-for-update");
              }),
          ).pipe(Effect.asVoid),
        on: (eventName, listener) =>
          Effect.acquireRelease(
            Effect.sync(() => {
              appListeners.set(
                eventName,
                listener as unknown as (...args: readonly unknown[]) => void,
              );
            }),
            () =>
              Effect.sync(() => {
                appListeners.delete(eventName);
              }),
          ).pipe(Effect.asVoid),
      } satisfies ElectronApp.ElectronApp["Service"]);

      const electronThemeLayer = Layer.succeed(ElectronTheme.ElectronTheme, {
        shouldUseDarkColors: Effect.succeed(false),
        setSource: () => Effect.void,
        onUpdated: () => Effect.void,
      });

      const desktopWindowLayer = Layer.succeed(DesktopWindow.DesktopWindow, {
        createMain: Effect.die("unexpected window creation"),
        ensureMain: Effect.die("unexpected window creation"),
        revealOrCreateMain: Effect.die("unexpected window creation"),
        activate: Effect.void,
        createMainIfBackendReady: Effect.void,
        showConnectingSplash: Effect.void,
        handleBackendReady: () => Effect.void,
        handleBackendNotReady: Effect.void,
        flushMainWindowBounds: Effect.void,
        dispatchMenuAction: () => Effect.void,
        syncAppearance: Effect.void,
      });

      const environmentLayer = Layer.succeed(DesktopEnvironment.DesktopEnvironment, {
        platform,
        isDevelopment: false,
      } as DesktopEnvironment.DesktopEnvironment["Service"]);

      const layer = DesktopLifecycle.layer.pipe(
        Layer.provideMerge(electronAppLayer),
        Layer.provideMerge(electronThemeLayer),
        Layer.provideMerge(desktopWindowLayer),
        Layer.provideMerge(environmentLayer),
        Layer.provideMerge(DesktopShutdown.layer),
        Layer.provideMerge(DesktopState.layer),
      );

      return Effect.scoped(
        Effect.gen(function* () {
          const lifecycle = yield* DesktopLifecycle.DesktopLifecycle;
          yield* lifecycle.register;

          appListeners.get("before-quit-for-update")?.();

          let prevented = false;
          const event = {
            preventDefault: () => {
              prevented = true;
            },
          } as Electron.Event;
          appListeners.get("before-quit")?.(event);

          assert.isFalse(
            prevented,
            "cancelling this event prevents the updater from completing its relaunch",
          );

          const state = yield* DesktopState.DesktopState;
          assert.isTrue(yield* Ref.get(state.quitting));
        }),
      ).pipe(Effect.provide(layer));
    });
  }
});
