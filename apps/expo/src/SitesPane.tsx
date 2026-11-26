import { memo, useCallback } from 'react';
import { FlatList, type ListRenderItemInfo, Pressable, StyleSheet, Text, View } from 'react-native';
import type { Site } from './data.ts';
import { color, formatNumber, ui } from './styles.ts';
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
  select,
}: {
  item: Site;
  selected: boolean;
  select: Props['select'];
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected: selected }}
      onPress={() => select(item.project)}
      style={({ pressed }) => [s.item, selected && s.active, pressed && ui.pressed]}
    >
      <View style={s.site}>
        <Text style={s.name}>{item.project}</Text>
        <Text style={ui.muted}>
          {formatNumber.format(item.visitors)} visitors · {formatNumber.format(item.pageviews)}{' '}
          views
        </Text>
      </View>
      <Text accessible={false} style={s.arrow}>
        ›
      </Text>
    </Pressable>
  );
});

const siteKey = (site: Site) => site.project;
export function SitesPane({ sites, active, loading, refreshing, error, select, refresh }: Props) {
  const renderSite = useCallback(
    ({ item }: ListRenderItemInfo<Site>) => (
      <SiteItem item={item} selected={active === item.project} select={select} />
    ),
    [active, select],
  );
  return (
    <FlatList
      style={ui.fill}
      contentContainerStyle={ui.pad}
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

const s = StyleSheet.create({
  heading: { gap: 12 },
  item: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    padding: 14,
    backgroundColor: color.card,
    borderWidth: 1,
    borderColor: color.line,
    borderRadius: 12,
  },
  active: { borderColor: color.accent, backgroundColor: '#e4efe5' },
  site: { flex: 1, gap: 5 },
  name: { color: color.ink, fontSize: 17, fontWeight: '600' },
  arrow: { fontSize: 25, color: color.accent },
});
