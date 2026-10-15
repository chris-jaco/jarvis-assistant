import { Menu, Tray, nativeImage, type MenuItemConstructorOptions, type NativeImage } from 'electron';
import {
  DesktopTrayController,
  type DesktopTrayActions,
  type DesktopTrayIcon,
  type DesktopTrayMenuItem,
  type DesktopTrayTarget
} from './tray-controller.js';

/** Electron adapter only; lifecycle authority remains injected into the controller. */
export function createElectronTrayController(iconPath: string, actions: DesktopTrayActions): DesktopTrayController {
  return new DesktopTrayController({
    loadIcon: () => nativeImage.createFromPath(iconPath) as DesktopTrayIcon,
    createTray: icon => new Tray(icon as NativeImage) as unknown as DesktopTrayTarget,
    buildMenu: items => Menu.buildFromTemplate(items.map(toElectronMenuItem)),
    actions
  });
}

function toElectronMenuItem(item: DesktopTrayMenuItem): MenuItemConstructorOptions {
  return { label: item.label, click: item.click };
}
