import { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { duration } from '../../../packages/dashboard/src/format.ts';
import { Breakdowns } from './Breakdowns.tsx';
import type { Report } from './data.ts';
import { formatNumber, themedStyles, useTheme } from './styles.ts';
import { Segments } from './ui.tsx';

const date = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' });
const percentage = new Intl.NumberFormat(undefined, { style: 'percent', maximumFractionDigits: 1 });

function Traffic({ report }: { report: Report }) {
  const { scheme, ui } = useTheme();
  const s = sheets[scheme];
  const { totals, previous, timeseries, range } = report;
  const [choice, select] = useState<'Visitors' | 'Pageviews'>('Visitors');
  const metric = choice === 'Pageviews' && timeseries.pageviews ? 'pageviews' : 'visitors';
  const series = timeseries[metric] ?? timeseries.visitors;
  const label = metric === 'pageviews' ? 'Pageviews' : 'Visitors';
  const max = Math.max(1, ...series);
  const delta =
    previous && previous[metric] > 0
      ? (totals[metric] - previous[metric]) / previous[metric]
      : null;
  return (
    <View style={[ui.panel, s.hero]}>
      {timeseries.pageviews ? (
        <Segments options={['Visitors', 'Pageviews'] as const} value={label} onChange={select} />
      ) : (
        <Text style={ui.muted}>Visitors</Text>
      )}
      <Text style={[s.heroNumber, ui.numeric]}>{formatNumber.format(totals[metric])}</Text>
      {delta !== null ? (
        <View style={ui.row}>
          <Text style={[s.delta, ui.numeric, delta > 0 && s.gain, delta < 0 && s.loss]}>
            {delta > 0 ? '+' : ''}
            {percentage.format(delta)}
          </Text>
          <Text style={ui.caption}>vs previous period</Text>
        </View>
      ) : null}
      <View
        style={[s.chart, { gap: timeseries.buckets.length > 45 ? 1 : 2 }]}
        accessible
        accessibilityLabel={`${label} over time. Highest bucket: ${formatNumber.format(Math.max(0, ...series))}.`}
      >
        <View style={s.grid} pointerEvents="none" accessible={false}>
          <View style={s.rule} />
          <View style={s.rule} />
          <View style={s.rule} />
        </View>
        {series.map((value, index) => (
          <View
            key={timeseries.buckets[index]}
            style={[s.bar, { height: `${(100 * value) / max}%` }]}
          />
        ))}
      </View>
      <View style={s.axis}>
        <Text style={s.axisText}>{date.format(new Date(range.from))}</Text>
        <Text style={s.axisText}>{date.format(new Date(range.to))}</Text>
      </View>
    </View>
  );
}

export function ReportView({ report }: { report: Report }) {
  const { scheme, ui } = useTheme();
  const s = sheets[scheme];
  const { totals, breakdowns } = report;
  const metrics = [
    ['Pageviews', formatNumber.format(totals.pageviews)],
    ['Sessions', formatNumber.format(totals.sessions)],
    ['Bounce rate', percentage.format(totals.bounceRate)],
    [
      'Session length',
      totals.avgSessionSeconds === undefined ? '—' : duration(totals.avgSessionSeconds),
    ],
    ['Views per session', totals.viewsPerSession?.toFixed(1) ?? '—'],
  ];

  return (
    <>
      <Traffic report={report} />
      <View style={s.metrics}>
        {metrics.map(([label, value]) => (
          <View key={label} style={s.metric}>
            <Text style={ui.caption}>{label}</Text>
            <Text style={[s.metricNumber, ui.numeric]}>{value}</Text>
          </View>
        ))}
      </View>
      <Breakdowns data={breakdowns} />
    </>
  );
}
const sheets = themedStyles((color) =>
  StyleSheet.create({
    hero: { gap: 4 },
    heroNumber: { color: color.ink, fontSize: 42, fontWeight: '700', letterSpacing: -1.3 },
    delta: {
      color: color.muted,
      backgroundColor: color.surface2,
      fontSize: 13,
      fontWeight: '600',
      borderRadius: 8,
      overflow: 'hidden',
      paddingHorizontal: 6,
      paddingVertical: 2,
    },
    gain: { color: color.good },
    loss: { color: color.bad },
    chart: {
      flexDirection: 'row',
      alignItems: 'flex-end',
      height: 92,
      marginTop: 16,
    },
    grid: { ...StyleSheet.absoluteFill, justifyContent: 'space-between' },
    rule: { borderTopColor: color.hairline, borderTopWidth: StyleSheet.hairlineWidth },
    bar: {
      flex: 1,
      backgroundColor: color.accent,
      borderTopLeftRadius: 2,
      borderTopRightRadius: 2,
    },
    axis: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: 8,
      flexWrap: 'wrap',
    },
    axisText: { fontSize: 12, color: color.muted, paddingTop: 3 },
    metrics: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      gap: 1,
      borderWidth: 1,
      borderColor: color.hairline,
      backgroundColor: color.hairline,
      borderRadius: 10,
      overflow: 'hidden',
    },
    metric: {
      flexGrow: 1,
      flexBasis: 90,
      padding: 12,
      gap: 6,
      backgroundColor: color.surface,
    },
    metricNumber: { fontSize: 23, color: color.ink, fontWeight: '700', letterSpacing: -0.5 },
  }),
);
