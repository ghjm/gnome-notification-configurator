import GLib from "gi://GLib";
import Shell from "gi://Shell";
import { InjectionManager } from "resource:///org/gnome/shell/extensions/extension.js";
import * as Main from "resource:///org/gnome/shell/ui/main.js";
import {
  MessageTray,
  type MessageTrayProto,
  type Notification,
  NotificationDestroyedReason,
  type Source,
} from "resource:///org/gnome/shell/ui/messageTray.js";
import type { SettingsManager } from "../../utils/settings.js";

type ApplicationSource = Source & {
  app?: Shell.App | null;
  _app?: Shell.App | null;
};

export class FocusManager {
  private injectionManager = new InjectionManager();
  private windowTracker = Shell.WindowTracker.get_default();
  private focusSignal?: number;
  private sourceAddedSignal?: number;
  private sourceSignals = new Map<Source, number[]>();
  private pending = new Set<Notification>();
  private pendingIdle?: number;

  constructor(private settingsManager: SettingsManager) {}

  enable() {
    this.focusSignal = global.display.connect("notify::focus-window", () => {
      for (const source of Main.messageTray.getSources()) {
        for (const notification of [...source.notifications]) {
          this.clearNotification(notification);
        }
      }
    });
    this.sourceAddedSignal = Main.messageTray.connect(
      "source-added",
      (_tray, source: Source) => this.watchSource(source),
    );
    for (const source of Main.messageTray.getSources()) {
      this.watchSource(source);
    }

    const manager = this;
    const prototype = MessageTray.prototype as unknown as MessageTrayProto;
    this.injectionManager.overrideMethod(
      prototype,
      "_hideNotificationCompleted",
      (original) =>
        function (this: MessageTrayProto) {
          const notification = this._notification;
          original.call(this);
          if (notification) {
            manager.deferNotification(notification);
          }
        },
    );
  }

  private watchSource(source: Source) {
    if (this.sourceSignals.has(source)) {
      return;
    }
    const signals = [
      source.connect("notification-added", (_source, notification) => {
        this.deferNotification(notification);
      }),
      source.connect("destroy", () => {
        for (const signal of signals) {
          source.disconnect(signal);
        }
        this.sourceSignals.delete(source);
      }),
    ];
    this.sourceSignals.set(source, signals);
  }

  private deferNotification(notification: Notification) {
    this.pending.add(notification);
    if (this.pendingIdle !== undefined) {
      return;
    }
    this.pendingIdle = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
      this.pendingIdle = undefined;
      const notifications = [...this.pending];
      this.pending.clear();
      const tray = Main.messageTray as unknown as MessageTrayProto;
      for (const notification of notifications) {
        if (
          tray._notification !== notification &&
          !tray._notificationQueue.includes(notification)
        ) {
          this.clearNotification(notification);
        }
      }
      return GLib.SOURCE_REMOVE;
    });
  }

  private clearNotification(notification: Notification) {
    const source = notification.source as ApplicationSource | null;
    const focusedWindow = global.display.get_focus_window();
    if (!source?.notifications.includes(notification) || !focusedWindow) {
      return;
    }
    const focusedApplication = this.windowTracker.get_window_app(focusedWindow);
    if (!focusedApplication) {
      return;
    }
    const application = source.app ?? source._app;
    const matchesApplication = application
      ? application === focusedApplication ||
        application.get_id() === focusedApplication.get_id()
      : source.title === focusedApplication.get_name();
    if (!matchesApplication) {
      return;
    }
    const configuration = this.settingsManager.getConfigurationFor(
      source.title,
      notification.title,
      notification.body,
    );
    if (
      configuration.enabled &&
      configuration.notificationCenter.clearOnFocus
    ) {
      notification.destroy(NotificationDestroyedReason.DISMISSED);
    }
  }

  disable() {
    this.injectionManager.clear();
    if (this.focusSignal !== undefined) {
      global.display.disconnect(this.focusSignal);
      this.focusSignal = undefined;
    }
    if (this.sourceAddedSignal !== undefined) {
      Main.messageTray.disconnect(this.sourceAddedSignal);
      this.sourceAddedSignal = undefined;
    }
    for (const [source, signals] of this.sourceSignals) {
      for (const signal of signals) {
        source.disconnect(signal);
      }
    }
    this.sourceSignals.clear();
    if (this.pendingIdle !== undefined) {
      GLib.source_remove(this.pendingIdle);
      this.pendingIdle = undefined;
    }
    this.pending.clear();
  }
}
