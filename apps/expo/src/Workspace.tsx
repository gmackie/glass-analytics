import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useCallback, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { DivisionObserver } from './DivisionObserver.tsx';
import { type Connection, fetchSites, type Period } from './data.ts';
import { demoSites } from './demo.ts';
import { type CompactPage, paneLayout, type Region, visiblePanes } from './layout.ts';
import { ReportPane } from './ReportPane.tsx';
import { SitesPane } from './SitesPane.tsx';
import { themedStyles, useTheme } from './styles.ts';
import { Brand, PeriodPicker } from './ui.tsx';

export function Workspace({
  connection,
  configure,
}: {
  connection: Connection | null;
  configure: () => void;
}) {
  const { scheme, ui } = useTheme();
  const s = sheets[scheme];
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [division, setDivision] = useState<Region | null>(null);
  const [days, setDays] = useState<Period>(7);
  const [selected, setSelected] = useState<string | null>(null);
  const [page, setPage] = useState<CompactPage>('auto');
  const sites = useQuery({
    queryKey: ['sites', days],
    placeholderData: keepPreviousData,
    queryFn: ({ signal }) => (connection ? fetchSites(connection, days, signal) : demoSites(days)),
  });
  const rows = sites.data ?? [];
  const layout = rows.length ? paneLayout(size.width, size.height, division) : null;
  const dimension = layout?.axis === 'column' ? 'height' : 'width';
  const project = rows.find((site) => site.project === selected)?.project ?? rows[0]?.project;
  const panes = visiblePanes(layout !== null, rows.length, page);
  const brand = <Brand live={connection !== null} configure={configure} />;
  const select = useCallback((id: string) => {
    setSelected(id);
    setPage('report');
  }, []);
  const refresh = () => {
    void sites.refetch();
  };
  return (
    <View
      style={[ui.fill, { flexDirection: layout?.axis ?? 'column' }]}
      onLayout={({
        nativeEvent: {
          layout: { width, height },
        },
      }) => setSize({ width, height })}
    >
      <DivisionObserver
        pointerEvents="none"
        accessible={false}
        style={StyleSheet.absoluteFill}
        onDivisionChange={(event) => setDivision(event.nativeEvent.region ?? null)}
      />
      {panes !== 'report' ? (
        <View style={layout ? [s.rail, { [dimension]: layout.first }] : ui.fill}>
          {brand}
          {panes === 'both' ? null : (
            <View style={s.range}>
              <PeriodPicker value={days} onChange={setDays} />
            </View>
          )}
          <SitesPane
            sites={rows}
            active={layout ? (project ?? null) : null}
            loading={sites.isPending}
            refreshing={sites.isRefetching}
            error={sites.error}
            select={select}
            refresh={refresh}
          />
        </View>
      ) : null}
      {layout ? <View style={[s.divider, { [dimension]: layout.gap }]} /> : null}
      {panes !== 'sites' && project ? (
        <View style={ui.fill}>
          {layout ? null : brand}
          <ReportPane
            key={project}
            project={project}
            connection={connection}
            days={days}
            onPeriod={setDays}
            back={layout ? undefined : () => setPage('sites')}
            refreshSites={refresh}
          />
        </View>
      ) : null}
    </View>
  );
}
const sheets = themedStyles((color) =>
  StyleSheet.create({
    rail: { backgroundColor: color.surface },
    range: { paddingHorizontal: 18, paddingTop: 14 },
    divider: { backgroundColor: color.hairline },
  }),
);
