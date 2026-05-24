import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.lifttrace.app',
  appName: 'LiftTrace',
  webDir: 'dist',
  // In dev, point to your local Vite dev server for live-reload on device.
  // Uncomment + set your machine's LAN IP when doing native dev builds:
  // server: { url: 'http://192.168.1.x:5173', cleartext: true },
  android: {
    // Allow http:// audio sources from a https://localhost WebView.
    // Chromium's mixed-content policy is independent of the OS-level
    // usesCleartextTraffic flag — this is the WebView setting that lets
    // HLS manifests, ICY streams, and Subsonic-over-LAN actually load.
    allowMixedContent: true,
    buildOptions: {
      keystorePath: undefined,
      keystoreAlias: undefined,
    },
  },
  server: {
    androidScheme: 'https',
  },
  plugins: {
    SplashScreen: {
      launchShowDuration: 1200,
      launchAutoHide: true,
      backgroundColor: '#0F1115',
      androidSplashResourceName: 'splash',
      showSpinner: false,
    },
    Keyboard: {
      resize: 'native',
    },
    StatusBar: {
      style: 'dark',
      backgroundColor: '#0F1115',
    },
    CapacitorSQLite: {
      iosDatabaseLocation: 'Library/CapacitorDatabase',
      iosIsEncryption: false,
      androidIsEncryption: false,
    },
  },
};

export default config;
