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
    // WebView identity for Android autofill. Without an explicit hostname
    // Capacitor serves from https://localhost/, which is what password
    // managers like Bitwarden read as the site name — so saved credentials
    // show up as "localhost". Setting a hostname makes the WebView report
    // https://app.lifttrace.local/ instead. .local (RFC 6762) is reserved
    // for local/private use, no collision risk.
    //
    // ONE-TIME UPGRADE COST: origin change orphans localStorage /
    // sessionStorage / IndexedDB / cookies. SQLite via
    // @capacitor-community/sqlite is origin-independent — workout data is
    // safe. Users on a linked server need to re-enter server URL + log in
    // once; standalone users see prefs default once.
    hostname: 'app.lifttrace.local',
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
