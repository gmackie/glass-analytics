import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { RefreshControl, ScrollView, Text, View } from 'react-native';
import { type Connection, fetchPaths, fetchReport, type Period } from './data.ts';
import { demoPaths, demoReport } from './demo.ts';
import { PathFlow } from './PathFlow.tsx';
import { ReportView } from './ReportView.tsx';
import { useTheme } from './styles.ts';
import { Action, Loading, Notice, PeriodPicker, Segments } from './ui.tsx';
import { mobileUsage } from './usage.ts';

export function ReportPane({
  project,
  connection,
  days,
  onPeriod,
  back,
  refreshSites,
}: {
  project: string;
  connection: Connection | null;
  days: Period;
  onPeriod: (days: Period) => void;
  back?: () => void;
  refreshSites: () => void;
}) {
  const { color, ui } = useTheme();
  const [view, setView] = useState<'Overview' | 'Paths'>('Overview');
  const [steps, setSteps] = useState<'Pages' | 'Pages + events'>('Pages');
  const events = view === 'Paths' && steps === 'Pages + events';
  const report = useQuery({
    queryKey: ['report', project, days, view, events],
    queryFn: ({ signal }) => {
      if (view === 'Paths')
        return connection
          ? fetchPaths(connection, project, days, events, signal)
          : demoPaths(days, events);
      return connection ? fetchReport(connection, project, days, signal) : demoReport(days);
    },
  });
  const mode = connection ? 'live' : 'demo';
  const screen = view === 'Paths' ? 'paths' : 'overview';
  useEffect(() => {
    mobileUsage.visit(screen, mode, project);
    // React Query exposes data only for the visible query. Cached data is a real view too.
    if (report.data)
      mobileUsage.reportResult()(
        screen,
        report.data.kind === 'web' ? report.data.totals.pageviews > 0 : report.data.total > 0,
      );
  }, [screen, mode, project, report.data]);
  const refresh = () => {
    refreshSites();
    void report.refetch();
  };
  return (
    <ScrollView
      style={ui.fill}
      contentContainerStyle={ui.pad}
      refreshControl={
        <RefreshControl
          refreshing={report.isRefetching}
          onRefresh={refresh}
          tintColor={color.accent}
        />
      }
    >
      {back ? (
        <View style={{ alignSelf: 'flex-start' }}>
          <Action onPress={back}>‹ Sites</Action>
        </View>
      ) : null}
      <Text accessibilityRole="header" style={ui.title}>
        {project}
      </Text>
      <View style={ui.row}>
        <Segments options={['Overview', 'Paths'] as const} value={view} onChange={setView} />
        <PeriodPicker value={days} onChange={onPeriod} />
      </View>
      {view === 'Paths' ? (
        <Segments
          options={['Pages', 'Pages + events'] as const}
          value={steps}
          onChange={setSteps}
        />
      ) : null}
      {report.isPending ? (
        <Loading label={view === 'Paths' ? 'Loading paths…' : 'Loading report…'} />
      ) : null}
      {report.isError ? (
        <Notice
          title={view === 'Paths' ? 'Couldn’t load paths' : 'Couldn’t load the report'}
          retry={refresh}
        >
          {report.error.message}
        </Notice>
      ) : null}
      {report.data?.kind === 'web' ? <ReportView report={report.data} /> : null}
      {report.data?.kind === 'paths' ? (
        <PathFlow key={`${days}-${steps}`} data={report.data} />
      ) : null}
    </ScrollView>
  );
}
