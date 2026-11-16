import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.dayflow.dailytasks',
  appName: 'Dayflow',
  webDir: 'dist',
  android: {
    allowMixedContent: false,
    // The password vault sends sensitive clipboard values across the native bridge.
    loggingBehavior: 'none',
    backgroundColor: '#0f172a',
  },
  plugins: {
    SplashScreen: {
      launchAutoHide: false,
      backgroundColor: '#0f172a',
      showSpinner: false,
    },
    LocalNotifications: {
      smallIcon: 'ic_stat_icon',
      iconColor: '#4f46e5',
    },
    // Live app-code updates, driven by src/services/appUpdater.ts from our own
    // GitHub Releases. Capgo's cloud is never used: automatic checks are off and
    // every URL points at our release feed; stats ('' disables them) stay off.
    CapacitorUpdater: {
      autoUpdate: false,
      statsUrl: '',
      updateUrl: 'https://github.com/SarathDeveloper/dayflow/releases/latest/download/update.json',
      channelUrl: 'https://github.com/SarathDeveloper/dayflow/releases/latest/download/update.json',
      allowModifyUrl: false,
      shakeMenu: false,
      // A fresh APK install drops downloaded code, so the APK's own (newest) code runs.
      resetWhenUpdate: true,
      autoDeletePrevious: true,
      autoDeleteFailed: true,
      // New code must report in within 15 s of starting, or it is rolled back.
      appReadyTimeout: 15000,
    },
  },
};

export default config;
