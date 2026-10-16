import { register, init, getLocaleFromNavigator } from 'svelte-i18n';

// Languages with a dedicated locale file. As contributors add translations,
// register them here and add an entry to AVAILABLE_LOCALES so the language
// picker in Settings → Units shows the new option.
register('en', () => import('./en.json'));
register('es', () => import('./es.json'));
register('it', () => import('./it.json'));
register('zh-Hans', () => import('./zh-Hans.json'));

export const AVAILABLE_LOCALES = [
  { code: 'en', label: 'English' },
  { code: 'es', label: 'Español' },
  { code: 'it', label: 'Italiano' },
  { code: 'zh-Hans', label: '简体中文' },
];

/**
 * The locale to use when the user has never chosen one: the phone or
 * browser's own language if we have it, English otherwise.
 *
 * Exported because the `language` setting has to default to the same value.
 * When it defaulted to a hardcoded 'en' instead, a Spanish phone ran the app
 * in Spanish while the picker in Settings sat on English, since the two were
 * deciding separately and never compared notes. Reported on r/selfhosted.
 */
export function pickInitialLocale() {
  return localeForNavigator(getLocaleFromNavigator());
}

/**
 * The app's locale for a browser or phone language tag. Chinese needs its
 * own rule: the app has Simplified Chinese (zh-Hans), which a phone reports
 * as zh-CN, zh-SG, zh-Hans-CN or plain zh, while Traditional Chinese
 * (zh-TW, zh-HK, zh-MO, zh-Hant) stays on English rather than getting the
 * other script.
 */
export function localeForNavigator(nav) {
  if (!nav) return 'en';
  const tag = String(nav).replace(/_/g, '-').toLowerCase();
  if (tag === 'zh' || tag.startsWith('zh-')) {
    return /^zh-(hant|tw|hk|mo)\b/.test(tag) ? 'en' : 'zh-Hans';
  }
  const short = tag.split('-')[0];
  return AVAILABLE_LOCALES.some(l => l.code === short) ? short : 'en';
}

export function initI18n(initialLocale) {
  init({
    fallbackLocale: 'en',
    initialLocale: initialLocale || pickInitialLocale(),
    // Log missing-key warnings to the browser console only in dev — in
    // production builds they'd spam the console for users running a locale
    // that isn't fully translated yet.
    warnOnMissingMessages: !!import.meta.env.DEV,
  });
}
