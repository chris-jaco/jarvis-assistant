import { isAbsolute } from 'node:path';
import { lstatSync } from 'node:fs';
export type ConfigurationIssue = 'ATLAS_BROWSER_HOST_PATH:missing' | 'ATLAS_BROWSER_HOST_PATH:not_absolute' | 'ATLAS_BROWSER_HOST_PATH:not_regular_file' | 'ATLAS_BROWSER_HOST_PATH:unavailable' | 'ATLAS_BROWSER_EXTENSION_ID:missing' | 'ATLAS_BROWSER_EXTENSION_ID:invalid';
export interface AttachedConfiguration { configured: boolean; issues: ConfigurationIssue[] }
export function attachedConfiguration(executable: string | undefined, extensionId: string | undefined): AttachedConfiguration {
  const issues: ConfigurationIssue[] = [];
  if (!executable) issues.push('ATLAS_BROWSER_HOST_PATH:missing');
  else if (!isAbsolute(executable)) issues.push('ATLAS_BROWSER_HOST_PATH:not_absolute');
  else { try { if (!lstatSync(executable).isFile()) issues.push('ATLAS_BROWSER_HOST_PATH:not_regular_file'); } catch { issues.push('ATLAS_BROWSER_HOST_PATH:unavailable'); } }
  if (!extensionId) issues.push('ATLAS_BROWSER_EXTENSION_ID:missing');
  else if (!/^[a-p]{32}$/.test(extensionId)) issues.push('ATLAS_BROWSER_EXTENSION_ID:invalid');
  return { configured: issues.length === 0, issues };
}
