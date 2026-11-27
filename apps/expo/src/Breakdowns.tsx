import { useState } from 'react';
import { ActionSheetIOS, Pressable, StyleSheet, Text, View } from 'react-native';
import { countryName } from '../../../packages/dashboard/src/format.ts';
import type { Report } from './data.ts';
import { formatNumber, themedStyles, useTheme } from './styles.ts';

const breakdowns = {
  pages: ['Top pages', 'Page'],
  entry_pages: ['Entry pages', 'Page'],
  exit_pages: ['Exit pages', 'Page'],
  referrers: ['Referrers', 'Referrer'],
  utm_source: ['UTM sources', 'Source'],
  utm_medium: ['UTM mediums', 'Medium'],
  utm_campaign: ['UTM campaigns', 'Campaign'],
  countries: ['Countries', 'Country'],
  devices: ['Devices', 'Device'],
  browsers: ['Browsers', 'Browser'],
  os: ['Operating systems', 'Operating system'],
} as const satisfies Record<keyof Report['breakdowns'], readonly [string, string]>;
type Dimension = keyof typeof breakdowns;
const dimensions = Object.keys(breakdowns) as Dimension[];

export function Breakdowns({ data }: { data: Report['breakdowns'] }) {
  const { scheme, ui } = useTheme();
  const styles = sheets[scheme];
  const [choice, setChoice] = useState<Dimension>('pages');
  const selected = data[choice] ? choice : 'pages';
  const rows = data[selected] ?? [];
  const [title, column] = breakdowns[selected];
  function choose(anchor?: number) {
    const available = dimensions.filter((key) => data[key] !== undefined);
    ActionSheetIOS.showActionSheetWithOptions(
      {
        title: 'Traffic breakdown',
        anchor,
        options: [
          ...available.map((key) => breakdowns[key][0] + (key === selected ? ' ✓' : '')),
          'Cancel',
        ],
        cancelButtonIndex: available.length,
      },
      (i) => {
        const next = available[i];
        if (next) setChoice(next);
      },
    );
  }
  return (
    <View style={ui.panel}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Traffic breakdown, ${title}`}
        accessibilityHint="Choose which traffic breakdown to view"
        onPress={(event) => choose(event.nativeEvent.target)}
        style={({ pressed }) => [styles.picker, pressed && ui.pressed]}
      >
        <Text style={ui.heading}>{title}</Text>
        <Text style={styles.chevron}>⌄</Text>
      </Pressable>
      {rows.length ? (
        <>
          <View style={styles.row}>
            <Text style={[ui.caption, ui.fill]}>{column}</Text>
            <Text style={[ui.caption, styles.value]}>Visitors</Text>
            <Text style={[ui.caption, styles.value]}>Views</Text>
          </View>
          {rows.map((row) => (
            <View key={row.value} style={[styles.row, styles.rule]}>
              <Text selectable style={[ui.body, ui.fill]}>
                {selected === 'countries' ? countryName(row.value) : row.value}
              </Text>
              <Text style={[ui.body, ui.numeric, styles.value]}>
                {row.visitors === undefined ? '—' : formatNumber.format(row.visitors)}
              </Text>
              <Text style={[ui.body, ui.numeric, styles.value]}>
                {formatNumber.format(row.count)}
              </Text>
            </View>
          ))}
        </>
      ) : (
        <Text style={ui.muted}>No {title.toLowerCase()} in this period.</Text>
      )}
    </View>
  );
}
const sheets = themedStyles((color) =>
  StyleSheet.create({
    picker: {
      flexDirection: 'row',
      alignItems: 'center',
      alignSelf: 'flex-start',
      minHeight: 44,
      gap: 8,
    },
    chevron: { color: color.accent, fontSize: 18 },
    row: { flexDirection: 'row', alignItems: 'center', gap: 8 },
    rule: {
      paddingTop: 10,
      borderTopColor: color.hairline,
      borderTopWidth: StyleSheet.hairlineWidth,
    },
    value: { minWidth: 54, textAlign: 'right' },
  }),
);
