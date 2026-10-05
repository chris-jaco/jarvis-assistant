export function popupSender(sender: { id?: string; url?: string; tab?: unknown }, extensionId: string, popupUrl: string): boolean { return sender.id === extensionId && sender.tab === undefined && sender.url === popupUrl; }
export function backendSender(sender: { id?: string; tab?: unknown }, extensionId: string): boolean { return sender.id === extensionId && sender.tab === undefined; }
