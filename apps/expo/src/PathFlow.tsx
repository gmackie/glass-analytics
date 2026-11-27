import type { PathNode } from '@dataflare/core/insights/paths';
import { useMemo, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import Svg, { Path, Rect } from 'react-native-svg';
import { percent } from '../../../packages/dashboard/src/format.ts';
import type { Paths } from './data.ts';
import { PathDetails, type PathSelection } from './PathDetails.tsx';
import { railWidth, sankeyLayout, touchHeight } from './sankey.ts';
import { formatNumber, formatPeople, themedStyles, useTheme } from './styles.ts';
import { Action, Notice } from './ui.tsx';

type FlowProps = { data: Paths; selected?: string; select: (choice: PathSelection) => void };
function Sankey({ data, selected, select }: FlowProps) {
  const { scheme, color, ui } = useTheme();
  const styles = sheets[scheme];
  const [viewport, measure] = useState(0);
  const flow = useMemo(() => sankeyLayout(data, viewport), [data, viewport]);
  const series = [color.accent, color.seriesViolet, color.seriesAmber, color.seriesRose];
  const shade = (node: PathNode) =>
    node.other ? color.muted : series[(node.column - 1) % series.length]!;
  const neighbors = new Set([selected]);
  for (const { link } of flow.bands) {
    if (link.source === selected) neighbors.add(link.target);
    if (link.target === selected) neighbors.add(link.source);
  }
  return (
    <View onLayout={(e) => measure(e.nativeEvent.layout.width)}>
      <ScrollView horizontal directionalLockEnabled showsHorizontalScrollIndicator>
        <View style={{ width: flow.width, height: flow.height }}>
          <Svg
            width={flow.width}
            height={flow.height}
            style={StyleSheet.absoluteFill}
            accessible={false}
            accessibilityElementsHidden
          >
            {flow.bands.map(({ link, source, path, width }) => (
              <Path
                key={JSON.stringify([link.source, link.target])}
                onPress={() => select(link)}
                d={path}
                fill="none"
                stroke={shade(source)}
                strokeWidth={width}
                strokeOpacity={
                  selected
                    ? link.source === selected || link.target === selected
                      ? 0.65
                      : 0.08
                    : 0.32
                }
              />
            ))}
            {flow.nodes.map(({ node, x, y, height }) => (
              <Rect
                key={node.id}
                x={x}
                y={y}
                width={railWidth}
                height={height}
                rx={2}
                fill={shade(node)}
                opacity={!selected || neighbors.has(node.id) ? 1 : 0.35}
              />
            ))}
            {flow.nodes
              .filter(({ node }) => node.dropOff > 0)
              .map(({ node, x, outgoing }) => (
                <Rect
                  key={node.id}
                  x={x + railWidth}
                  y={outgoing}
                  width={10}
                  height={node.dropOff * flow.scale}
                  fill={color.muted}
                  opacity={0.35}
                />
              ))}
          </Svg>
          {flow.columns.map((column) => (
            <Text
              key={column}
              style={[ui.caption, styles.step, { left: (column - 1) * flow.pitch }]}
            >
              Step {column}
            </Text>
          ))}
          {flow.nodes.map(({ node, x, labelY }) => (
            <Pressable
              key={node.id}
              accessibilityRole="button"
              accessibilityLabel={`Step ${node.column}, ${node.label}, ${formatPeople(node.count)}`}
              accessibilityState={{ selected: selected === node.id }}
              style={({ pressed }) => [
                styles.labelTarget,
                { left: x, top: labelY, width: Math.min(110, flow.pitch - 24) },
                pressed && ui.pressed,
              ]}
              onPress={() => select({ node: node.id })}
            >
              <View style={[styles.label, selected === node.id && styles.activeLabel]}>
                <Text numberOfLines={1} style={styles.nodeName}>
                  {node.label}
                </Text>
                <Text style={[ui.caption, ui.numeric]}>{formatNumber.format(node.count)}</Text>
              </View>
            </Pressable>
          ))}
        </View>
      </ScrollView>
    </View>
  );
}

function TopPaths({ data }: { data: Paths }) {
  const { scheme, ui } = useTheme();
  const styles = sheets[scheme];
  const [all, showAll] = useState(false);
  if (!data.topPaths.length) return null;
  return (
    <View style={ui.panel}>
      <Text accessibilityRole="header" style={ui.heading}>
        Top paths
      </Text>
      <View style={ui.row}>
        <Text style={[ui.caption, ui.fill]}>Journey</Text>
        <Text style={ui.caption}>People</Text>
      </View>
      {data.topPaths.slice(0, all ? undefined : 5).map(({ items, count }) => (
        <View key={JSON.stringify(items)} style={styles.detailRow}>
          <Text selectable style={[ui.body, ui.fill]}>
            {items.join(' → ')}
          </Text>
          <View style={styles.counts}>
            <Text style={[ui.body, ui.numeric]}>{formatNumber.format(count)}</Text>
            <Text style={ui.caption}>{percent(count / data.total)}</Text>
          </View>
        </View>
      ))}
      {data.topPaths.length > 5 ? (
        <Action onPress={() => showAll(!all)}>
          {all ? 'Show fewer paths' : `Show all ${data.topPaths.length} paths`}
        </Action>
      ) : null}
    </View>
  );
}

export function PathFlow({ data }: { data: Paths }) {
  const { ui } = useTheme();
  const [choice, select] = useState<PathSelection>();
  const selected = choice && 'node' in choice ? choice.node : undefined;
  if (!data.total || !data.nodes.length)
    return <Notice title="No paths in this period">Try a longer period or include events.</Notice>;
  return (
    <>
      <View style={ui.panel}>
        <Text accessibilityRole="header" style={ui.heading}>
          Visitor paths
        </Text>
        <Text style={ui.muted}>{formatPeople(data.total)} · first path per person</Text>
        <Text style={ui.caption}>
          Tap a step or a band for details. Swipe across to see later steps.
        </Text>
        <Sankey data={data} selected={selected} select={select} />
        {choice ? (
          <PathDetails
            data={data}
            choice={choice}
            select={select}
            close={() => select(undefined)}
          />
        ) : null}
      </View>
      <TopPaths data={data} />
    </>
  );
}

const sheets = themedStyles((c) =>
  StyleSheet.create({
    step: { position: 'absolute', top: 0, fontWeight: '600' },
    labelTarget: {
      position: 'absolute',
      height: touchHeight,
      justifyContent: 'center',
      paddingLeft: railWidth + 4,
      alignItems: 'flex-start',
    },
    label: { maxWidth: '100%', borderRadius: 4, paddingHorizontal: 4, backgroundColor: c.surface },
    activeLabel: { backgroundColor: c.pane },
    nodeName: { color: c.ink, fontSize: 13, fontWeight: '600' },
    detailRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 12,
      minHeight: 44,
      paddingVertical: 6,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: c.hairline,
    },
    counts: { alignItems: 'flex-end' },
  }),
);
