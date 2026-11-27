import { ActionSheetIOS, Appearance, Settings } from 'react-native';

const preferenceKey = 'dataflareAppearance';
const choices = ['System', 'Light', 'Dark'] as const;
const schemes = { System: 'auto', Light: 'light', Dark: 'dark' } as const;

function preference(): (typeof choices)[number] {
  const saved: unknown = Settings.get(preferenceKey);
  return saved === 'Light' || saved === 'Dark' ? saved : 'System';
}

export function restoreAppearance() {
  Appearance.setColorScheme(schemes[preference()]);
}

export function showAppearancePicker(anchor?: number) {
  const current = preference();
  ActionSheetIOS.showActionSheetWithOptions(
    {
      title: 'Appearance',
      options: [...choices.map((label) => (label === current ? `${label} ✓` : label)), 'Cancel'],
      cancelButtonIndex: choices.length,
      anchor,
    },
    (index) => {
      const selected = choices[index];
      if (!selected) return;
      Settings.set({ [preferenceKey]: selected });
      Appearance.setColorScheme(schemes[selected]);
    },
  );
}
