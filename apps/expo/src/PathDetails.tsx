import type { PathLink, PathNode } from '@dataflare/core/insights/paths';
import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { duration, percent } from '../../../packages/dashboard/src/format.ts';
import type { Paths } from './data.ts';
import { formatNumber, formatPeople, themedStyles, useTheme } from './styles.ts';
import { Action } from './ui.tsx';

export type PathSelection = { node: string } | Pick<PathLink, 'source' | 'target'>;

type SelectionProps = { data: Paths; select: (choice: PathSelection) => void };

function Transitions({
  data,
  node,
  incoming,
  select,
}: SelectionProps & { node: PathNode; incoming: boolean }) {
  const { scheme, ui } = useTheme();
  const s = sheets[scheme];
  const anchor = incoming ? 'target' : 'source';
  const neighbor = incoming ? 'source' : 'target';
  const links = data.links.filter((link) => link[anchor] === node.id);
  if (!links.length) return null;
  return (
    <View style={s.transitions}>
      <Text style={ui.heading}>{incoming ? 'Arrived from' : 'Continued to'}</Text>
      {links.map((link) => (
        <Pressable
          key={link[neighbor]}
          accessibilityRole="button"
          onPress={() => select(link)}
          style={({ pressed }) => [s.row, pressed && ui.pressed]}
        >
          <Text style={[ui.body, ui.fill]}>
            {data.nodes.find((n) => n.id === link[neighbor])?.label}
          </Text>
          <View style={s.counts}>
            <Text style={[ui.body, ui.numeric]}>{formatPeople(link.count)}</Text>
            {link.avgSeconds === null ? null : (
              <Text style={ui.caption}>{duration(link.avgSeconds)} avg.</Text>
            )}
          </View>
        </Pressable>
      ))}
    </View>
  );
}

function StepDetails({ data, node, select }: SelectionProps & { node: PathNode }) {
  const { ui } = useTheme();
  return (
    <>
      <Text style={ui.caption}>Step {node.column}</Text>
      <Text selectable accessibilityRole="header" style={ui.title}>
        {node.label}
      </Text>
      <Text style={ui.body}>
        {formatPeople(node.count)} · {percent(node.count / data.total)} of all paths
      </Text>
      {node.other ? <Text style={ui.muted}>Less frequent steps grouped together</Text> : null}
      {node.column < data.steps ? (
        <Text style={ui.muted}>
          {formatNumber.format(node.dropOff)} stopped here ({percent(node.dropOff / node.count, 0)})
        </Text>
      ) : null}
      <Transitions data={data} node={node} select={select} incoming />
      <Transitions data={data} node={node} select={select} incoming={false} />
    </>
  );
}

function LinkDetails({ data, link, select }: SelectionProps & { link: PathLink }) {
  const { ui } = useTheme();
  const source = data.nodes.find((n) => n.id === link.source);
  const target = data.nodes.find((n) => n.id === link.target);
  if (!source || !target) return null;
  return (
    <>
      <Text style={ui.caption}>
        Step {source.column} → Step {target.column}
      </Text>
      <Text selectable accessibilityRole="header" style={ui.title}>
        {source.label} → {target.label}
      </Text>
      <Text style={ui.body}>
        {formatPeople(link.count)} · {percent(link.count / source.count)} of people at the source
        step
      </Text>
      {link.avgSeconds === null ? null : (
        <Text style={ui.muted}>{duration(link.avgSeconds)} between steps on average</Text>
      )}
      <View style={ui.row}>
        <Action onPress={() => select({ node: source.id })}>View source step</Action>
        <Action onPress={() => select({ node: target.id })}>View destination step</Action>
      </View>
    </>
  );
}

export function PathDetails({
  data,
  choice,
  select,
  close,
}: SelectionProps & { choice: PathSelection; close: () => void }) {
  const { ui } = useTheme();
  const node = 'node' in choice ? data.nodes.find((n) => n.id === choice.node) : undefined;
  const link =
    'source' in choice
      ? data.links.find((l) => l.source === choice.source && l.target === choice.target)
      : undefined;
  if (!node && !link) return null;
  return (
    <Modal visible animationType="slide" presentationStyle="pageSheet" onRequestClose={close}>
      <SafeAreaView style={ui.screen}>
        <ScrollView key={JSON.stringify(choice)} contentContainerStyle={ui.pad}>
          <View style={ui.row}>
            <Text style={[ui.heading, ui.fill]}>{node ? 'Path step' : 'Path transition'}</Text>
            <Action onPress={close}>Done</Action>
          </View>
          {node ? <StepDetails data={data} node={node} select={select} /> : null}
          {link ? <LinkDetails data={data} link={link} select={select} /> : null}
        </ScrollView>
      </SafeAreaView>
    </Modal>
  );
}

const sheets = themedStyles((c) =>
  StyleSheet.create({
    transitions: { gap: 6 },
    counts: { alignItems: 'flex-end' },
    row: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 12,
      minHeight: 44,
      paddingVertical: 6,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: c.hairline,
    },
  }),
);
