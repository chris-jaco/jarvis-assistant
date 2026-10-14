export function acquireSingleInstance(application: { requestSingleInstanceLock(): boolean; quit(): void }): boolean {
  const acquired = application.requestSingleInstanceLock();
  if (!acquired) application.quit();
  return acquired;
}

export function focusExistingWindow(window: { isMinimized(): boolean; restore(): void; show(): void; focus(): void } | undefined): void {
  if (!window) return;
  if (window.isMinimized()) window.restore();
  window.show(); window.focus();
}
