export type ThemeMode = 'dark' | 'light' | 'system';

export type ResolvedTheme = 'dark' | 'light';

export type ThemeIcon = 'sun' | 'moon' | 'monitor';

export const THEME_STORAGE_KEY = 'dockpilot-theme';

export const THEME_OPTIONS: ReadonlyArray<{
  mode: ThemeMode;
  label: string;
  icon: ThemeIcon;
}> = [
  { mode: 'dark', label: 'Oscuro', icon: 'moon' },
  { mode: 'light', label: 'Claro', icon: 'sun' },
  { mode: 'system', label: 'Sistema', icon: 'monitor' },
];

/** Orden en el que `toggleTheme` recorre los modos. */
export const THEME_CYCLE_ORDER: ReadonlyArray<ThemeMode> = ['system', 'light', 'dark'];
