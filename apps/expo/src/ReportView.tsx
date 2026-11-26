import { StyleSheet, Text, View } from 'react-native';
import type { Report } from './data.ts';
import { color, formatNumber, ui } from './styles.ts';
import { Notice } from './ui.tsx';

const date = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' });
const percentage = new Intl.NumberFormat(undefined, { style: 'percent', maximumFractionDigits: 1 });
const change = new Intl.NumberFormat(undefined, {
  style: 'percent',
  maximumFractionDigits: 1,
  signDisplay: 'exceptZero',
});

function Traffic({ report }: { report: Report }) {
  const { totals, previous, timeseries, range } = report;
  const max = Math.max(1, ...timeseries.visitors);
  const comparison =
    previous && previous.visitors > 0
      ? `${change.format((totals.visitors - previous.visitors) / previous.visitors)} vs previous period`
      : null;
  return (
    <View style={s.hero}>
      <Text style={s.heroLabel}>Visitors</Text>
      <Text style={[s.heroNumber, ui.numeric]}>{formatNumber.format(totals.visitors)}</Text>
      {comparison ? <Text style={s.comparison}>{comparison}</Text> : null}
      <View
        style={[s.chart, { gap: timeseries.buckets.length > 45 ? 1 : 2 }]}
        accessible
        accessibilityLabel={`Visitors over time. Highest bucket: ${formatNumber.format(Math.max(0, ...timeseries.visitors))}.`}
      >
        {timeseries.visitors.map((value, index) => (
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
  const { totals, breakdowns } = report;
  const metrics = [
    ['Pageviews', formatNumber.format(totals.pageviews)],
    ['Sessions', formatNumber.format(totals.sessions)],
    ['Bounce rate', percentage.format(totals.bounceRate)],
  ];
  const pages = breakdowns.pages.slice(0, 10);
  return (
    <>
      <Traffic report={report} />
      <View style={s.metrics}>
        {metrics.map(([label, value]) => (
          <View key={label} style={s.metric}>
            <Text style={ui.muted}>{label}</Text>
            <Text style={[s.metricNumber, ui.numeric]}>{value}</Text>
          </View>
        ))}
      </View>
      {pages.length ? (
        <View style={ui.panel}>
          <View style={s.axis}>
            <Text accessibilityRole="header" style={ui.heading}>
              Top pages
            </Text>
            <Text style={ui.muted}>Views</Text>
          </View>
          {pages.map((page) => (
            <View key={page.value} style={s.page}>
              <Text selectable style={[ui.body, ui.fill]}>
                {page.value}
              </Text>
              <Text style={[ui.body, ui.numeric]}>{formatNumber.format(page.count)}</Text>
            </View>
          ))}
        </View>
      ) : (
        <Notice title="No pageviews">No pages were viewed in this period.</Notice>
      )}
    </>
  );
}
const s = StyleSheet.create({
  hero: { backgroundColor: color.forest, borderRadius: 19, padding: 20, gap: 4 },
  heroLabel: { color: '#d6eedf', fontSize: 16, fontWeight: '500' },
  heroNumber: { color: '#fff', fontSize: 45, fontWeight: '600', letterSpacing: -1.6 },
  comparison: { color: color.mint, fontSize: 14 },
  chart: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    height: 92,
    marginTop: 16,
    borderBottomColor: '#638979',
    borderBottomWidth: 1,
  },
  bar: { flex: 1, backgroundColor: color.mint, borderTopLeftRadius: 2, borderTopRightRadius: 2 },
  axis: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
    flexWrap: 'wrap',
  },
  axisText: { fontSize: 12, color: '#c4e0cf', paddingTop: 3 },
  metrics: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  metric: {
    flexGrow: 1,
    flexBasis: 90,
    borderRadius: 12,
    padding: 12,
    gap: 6,
    backgroundColor: '#e8efe6',
  },
  metricNumber: { fontSize: 21, color: color.ink, fontWeight: '600' },
  page: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingTop: 10,
    borderTopColor: color.line,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
});
