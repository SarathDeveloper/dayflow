import { Capacitor, registerPlugin } from '@capacitor/core';
import { isNativeAndroid } from '../lib/platform';

interface PasswordVaultPlugin {
  read(): Promise<{ contents?: string }>;
  write(options: { contents: string; previous?: string }): Promise<void>;
  setScreenProtected(options: { enabled: boolean }): Promise<void>;
  copySecret(options: { text: string }): Promise<void>;
  exportBackup(options: { contents: string; filename: string }): Promise<{ saved: boolean }>;
}

export const PasswordVault = registerPlugin<PasswordVaultPlugin>('PasswordVault');

export function hasPasswordVault(): boolean {
  return isNativeAndroid() && Capacitor.isPluginAvailable('PasswordVault');
}
