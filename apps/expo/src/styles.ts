import { StyleSheet, useColorScheme } from 'react-native';
import { dashboardPalette } from './palette.ts';

export const formatNumber = new Intl.NumberFormat(undefined);
export const formatPeople = (n: number) =>
  `${formatNumber.format(n)} ${n === 1 ? 'person' : 'people'}`;

function makeTheme(scheme: 'light' | 'dark') {
  // Native layer borders can retain a dynamic color resolved before the window's appearance changes.
  const color = Object.fromEntries(
    Object.entries(dashboardPalette).map(([name, pair]) => [name, pair[scheme]]),
  ) as Record<keyof typeof dashboardPalette, string>;
  const ui = StyleSheet.create({
    fill: { flex: 1 },
    screen: { flex: 1, backgroundColor: color.field },
    body: { color: color.ink, fontSize: 16 },
    muted: { color: color.muted, fontSize: 14 },
    caption: { color: color.muted, fontSize: 13 },
    title: { fontSize: 26, fontWeight: '700', color: color.ink, letterSpacing: -0.6 },
    heading: { fontSize: 17, fontWeight: '600', color: color.ink },
    numeric: { fontVariant: ['tabular-nums'] },
    panel: {
      backgroundColor: color.surface,
      borderRadius: 10,
      borderWidth: 1,
      borderColor: color.hairline,
      padding: 16,
      gap: 12,
    },
    button: {
      minHeight: 44,
      paddingHorizontal: 13,
      justifyContent: 'center',
      alignItems: 'center',
      borderWidth: 1,
      borderColor: color.hairlineStrong,
      borderRadius: 6,
      backgroundColor: color.surface,
    },
    buttonText: { fontSize: 15, fontWeight: '600', color: color.ink },
    primary: { backgroundColor: color.accent, borderColor: color.accent },
    inverted: { color: color.onPrimary },
    row: { flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
    pad: { paddingHorizontal: 18, paddingVertical: 16, gap: 14 },
    pressed: { opacity: 0.65 },
    disabled: { opacity: 0.45 },
  });
  return { scheme, color, ui };
}

const light = makeTheme('light');
const dark = makeTheme('dark');

export function useTheme() {
  return useColorScheme() === 'dark' ? dark : light;
}

export function themedStyles<T>(create: (color: typeof light.color) => T) {
  return { light: create(light.color), dark: create(dark.color) };
}
