import { memo, useCallback } from 'react';
import { FlatList, type ListRenderItemInfo, Pressable, StyleSheet, Text, View } from 'react-native';
import type { Site } from './data.ts';
import { formatNumber, themedStyles, useTheme } from './styles.ts';
import { Loading, Notice } from './ui.tsx';

type Props = {
  sites: Site[];
  active: string | null;
  loading: boolean;
  refreshing: boolean;
  error: Error | null;
  select: (project: string) => void;
  refresh: () => void;
};

const SiteItem = memo(function SiteItem({
  item,
  selected,
  first,
  last,
  select,
}: {
  item: Site;
  selected: boolean;
  first: boolean;
  last: boolean;
  select: Props['select'];
}) {
  const { scheme, ui } = useTheme();
  const s = sheets[scheme];
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected }}
      onPress={() => select(item.project)}
      style={({ pressed }) => [
        s.item,
        first && s.first,
        last && s.last,
        pressed && s.pressed,
        selected && s.active,
      ]}
    >
      <View style={s.site}>
        <Text style={[s.name, selected && s.selectedName]}>{item.project}</Text>
        <Text style={[ui.caption, ui.numeric]}>
          {formatNumber.format(item.visitors)} visitors · {formatNumber.format(item.pageviews)}{' '}
          views
        </Text>
      </View>
      <Text accessible={false} style={[s.arrow, selected && s.selectedName]}>
        ›
      </Text>
    </Pressable>
  );
});

const siteKey = (site: Site) => site.project;
export function SitesPane({ sites, active, loading, refreshing, error, select, refresh }: Props) {
  const { scheme, ui } = useTheme();
  const s = sheets[scheme];
  const renderSite = useCallback(
    ({ item, index }: ListRenderItemInfo<Site>) => (
      <SiteItem
        item={item}
        selected={active === item.project}
        first={index === 0}
        last={index === sites.length - 1}
        select={select}
      />
    ),
    [active, select, sites.length],
  );
  return (
    <FlatList
      style={ui.fill}
      contentContainerStyle={s.list}
      data={sites}
      keyExtractor={siteKey}
      extraData={active}
      onRefresh={refresh}
      refreshing={refreshing}
      ListHeaderComponent={
        <View style={s.heading}>
          <Text accessibilityRole="header" style={ui.title}>
            Sites
          </Text>
          {error ? (
            <Notice title="Couldn’t load sites" retry={refresh}>
              {error.message}
            </Notice>
          ) : null}
        </View>
      }
      ListEmptyComponent={
        loading ? (
          <Loading label="Loading sites…" />
        ) : !error ? (
          <Notice title="No sites yet">Create a project on your Worker to see it here.</Notice>
        ) : undefined
      }
      renderItem={renderSite}
    />
  );
}

const sheets = themedStyles((color) =>
  StyleSheet.create({
    list: { paddingHorizontal: 18, paddingVertical: 16 },
    heading: { gap: 12, marginBottom: 12 },
    item: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 10,
      paddingHorizontal: 14,
      paddingVertical: 12,
      backgroundColor: color.surface,
      borderLeftWidth: 1,
      borderRightWidth: 1,
      borderBottomWidth: 1,
      borderColor: color.hairline,
    },
    first: { borderTopLeftRadius: 10, borderTopRightRadius: 10, borderTopWidth: 1 },
    last: { borderBottomLeftRadius: 10, borderBottomRightRadius: 10 },
    pressed: { backgroundColor: color.surface2 },
    active: { backgroundColor: color.pane },
    site: { flex: 1, gap: 4 },
    name: { color: color.ink, fontSize: 16, fontWeight: '600' },
    selectedName: { color: color.paneInk },
    arrow: { fontSize: 22, color: color.muted },
  }),
);
