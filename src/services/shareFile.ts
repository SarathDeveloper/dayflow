import { saveBackupFile } from '../lib/backup';
import { isNativeAndroid } from '../lib/platform';
import { DayflowAlarm } from './dayflowAlarm';

/** Hands a text file (CSV, PDF text) to the Android share sheet, or saves / shares it on the website. */
export async function shareTextFile(contents: string, filename: string, mimeType: string, title: string): Promise<void> {
  if (isNativeAndroid()) {
    await DayflowAlarm.shareBackup({ filename, contents, mimeType, title });
  } else {
    await saveBackupFile(contents, filename, { type: mimeType, title });
  }
}
