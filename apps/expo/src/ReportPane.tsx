import { useQuery } from '@tanstack/react-query';
import { RefreshControl, ScrollView, Text, View } from 'react-native';
import { type Connection, fetchReport, type Period } from './data.ts';
import { demoReport } from './demo.ts';
import { ReportView } from './ReportView.tsx';
import { ui } from './styles.ts';
import { Action, Loading, Notice, PeriodPicker } from './ui.tsx';

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
  const report = useQuery({
    queryKey: ['report', project, days],
    queryFn: ({ signal }) =>
      connection ? fetchReport(connection, project, days, signal) : demoReport(days),
  });
  const refresh = () => {
    refreshSites();
    void report.refetch();
  };
  return (
    <ScrollView
      style={ui.fill}
      contentContainerStyle={ui.pad}
      refreshControl={<RefreshControl refreshing={report.isRefetching} onRefresh={refresh} />}
    >
      {back ? (
        <View style={{ alignSelf: 'flex-start' }}>
          <Action onPress={back}>‹ Sites</Action>
        </View>
      ) : null}
      <Text accessibilityRole="header" style={ui.title}>
        {project}
      </Text>
      <PeriodPicker value={days} onChange={onPeriod} />
      {report.isPending ? <Loading label="Loading report…" /> : null}
      {report.isError ? (
        <Notice title="Couldn’t load the report" retry={refresh}>
          {report.error.message}
        </Notice>
      ) : null}
      {report.data ? <ReportView report={report.data} /> : null}
    </ScrollView>
  );
}
