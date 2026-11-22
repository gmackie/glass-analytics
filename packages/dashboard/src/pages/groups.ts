/**
 * Groups (group analytics): companies, workspaces or any other group type your
 * app sets with glass.group(type, key, properties), and one group in detail.
 */

import { api } from '../api.ts';
import { barList, kpiStat } from '../components/charts.ts';
import { empty, later, pageHeader, panel, table, tabs, toast } from '../components/ui.ts';
import { h } from '../dom.ts';
import { ago, capitalize, count } from '../format.ts';
import { go, href, type Route, scope } from '../state.ts';

interface GroupType {
  type: string;
  singular: string;
  plural: string;
  groups: number;
}

interface GroupRow {
  key: string;
  properties: Record<string, unknown>;
  lastSeen: string;
  firstSeen: string;
}

async function groupTable(
  p: URLSearchParams,
  type: string,
  types: GroupType[],
): Promise<HTMLElement> {
  const q = p.get('q');
  const r = await api.get<{ groups: GroupRow[]; summary: string }>('/api/groups', {
    project: scope().project,
    type,
    search: q,
    limit: 200,
  });
  if (!r.groups.length) return empty(r.summary);
  const keys = [...new Set(r.groups.flatMap((g) => Object.keys(g.properties)))].slice(0, 4);
  const t = types.find((x) => x.type === type);
  const singular = t?.singular ?? type;
  const noun = r.groups.length === 1 ? singular : (t?.plural ?? type);
  return panel(
    `${count(r.groups.length)} ${noun}`,
    table(
      [capitalize(singular), ...keys, 'Last seen'],
      r.groups.map((g) => [
        h(
          'a',
          { href: href(`groups/${encodeURIComponent(type)}/${encodeURIComponent(g.key)}`) },
          g.key,
        ),
        ...keys.map((k) => (g.properties[k] === undefined ? '' : String(g.properties[k]))),
        ago(g.lastSeen),
      ]),
    ),
    {
      icon: 'layers',
      subtitle: q ? `Matching "${q}", most recently active first` : 'Most recently active first',
    },
  );
}

function groupList(route: Route, types: GroupType[]): HTMLElement {
  const p = route.params;
  const type = p.get('type') ?? types[0]!.type;
  const search = h('input', {
    type: 'search',
    placeholder: 'Search key or properties',
    value: p.get('q') ?? '',
    class: 'search-input',
  });
  search.addEventListener('change', () => go('groups', { type, q: search.value || null }));
  return h(
    'div',
    {},
    h(
      'div',
      { class: 'toolbar' },
      tabs(
        types.map((t) => ({
          value: t.type,
          label: `${capitalize(t.plural)} (${count(t.groups)})`,
        })),
        type,
        (v) => go('groups', { type: v }),
      ),
      search,
    ),
    later(() => groupTable(p, type, types), 'Loading groups', 'table'),
  );
}

function groupDetail(type: string, key: string): HTMLElement {
  return later(async () => {
    const { from, to, project } = scope();
    const g = await api.get<{
      properties: Record<string, unknown>;
      firstSeen: string | null;
      lastSeen: string | null;
      activity: { events: number; people: number; sessions: number };
      topEvents: { event: string; count: number }[];
      members: { person: string; events: number; lastSeen: string }[];
      recentEvents: { event: string; time: string; person: string; path: string }[];
      revenue?: { net: number; mrr: number; currency: string };
      summary: string;
      sql: string[];
    }>(`/api/groups/${encodeURIComponent(type)}/${encodeURIComponent(key)}`, { project, from, to });
    const money = (n: number) =>
      new Intl.NumberFormat(undefined, {
        style: 'currency',
        currency: g.revenue?.currency ?? 'USD',
      }).format(n);
    const remove = h(
      'button',
      {
        type: 'button',
        class: 'danger',
        onclick: async () => {
          if (
            !confirm(
              `Delete ${type} "${key}"? Its properties go, and it is removed from its events (they stay with their people).`,
            )
          )
            return;
          try {
            const r = await api.delete<{ summary: string }>(
              `/api/groups/${encodeURIComponent(type)}/${encodeURIComponent(key)}`,
              { project },
            );
            toast(r.summary);
            go('groups', { type });
          } catch (err) {
            toast(err instanceof Error ? err.message : String(err), 'error');
          }
        },
      },
      'Delete group',
    );
    return [
      pageHeader(key, `${type}${g.firstSeen ? ` · first seen ${ago(g.firstSeen)}` : ''}`, remove),
      h(
        'div',
        { class: 'stats stats-panel' },
        kpiStat('Events', count(g.activity.events)),
        kpiStat('Active people', count(g.activity.people)),
        kpiStat('Sessions', count(g.activity.sessions)),
        g.revenue
          ? kpiStat('Net revenue', money(g.revenue.net), `MRR ${money(g.revenue.mrr)}`)
          : null,
        g.lastSeen ? kpiStat('Last seen', ago(g.lastSeen)) : null,
      ),
      h(
        'div',
        { class: 'grid-2' },
        panel(
          'Properties',
          Object.keys(g.properties).length
            ? table(
                ['Property', 'Value'],
                Object.entries(g.properties).map(([k, v]) => [
                  h('span', { class: 'kv-key' }, k),
                  typeof v === 'string' ? v : JSON.stringify(v),
                ]),
                {
                  class: 'kv-table',
                },
              )
            : empty(
                `Set them with glass.group('${type}', '${key}', { … }) or set_group_properties.`,
              ),
          { icon: 'hash' },
        ),
        panel(
          'Top events',
          barList(
            g.topEvents.map((e) => ({ label: e.event, value: e.count })),
            ['Event', 'Count'],
          ),
          {
            icon: 'events',
            sql: g.sql,
          },
        ),
      ),
      panel(
        'Members',
        g.members.length
          ? table(
              ['Person', 'Events', 'Last seen'],
              g.members.map((m) => [
                h('a', { href: href(`users/${encodeURIComponent(m.person)}`) }, m.person),
                count(m.events),
                h('span', { class: 'nowrap' }, ago(m.lastSeen)),
              ]),
              { numeric: [1] },
            )
          : empty('No activity in this range.'),
        { icon: 'users', subtitle: g.summary },
      ),
      panel(
        'Recent events',
        table(
          ['When', 'Event', 'Person', 'Page'],
          g.recentEvents.map((e) => [
            h('span', { class: 'nowrap' }, ago(e.time)),
            e.event,
            e.person,
            e.path,
          ]),
        ),
        { icon: 'clock' },
      ),
    ];
  });
}

export function groupsPage(route: Route): Node[] {
  const [type, key] = route.rest;
  if (type && key) return [groupDetail(type, key)];
  return [
    pageHeader('Groups', 'Companies, workspaces and other groups.'),
    later(async () => {
      const r = await api.get<{ types: GroupType[] }>('/api/groups/types', {
        project: scope().project,
      });
      if (!r.types.length) {
        return empty(
          "Tell Dataflare which company (or workspace, team…) a user belongs to: glass.group('company', company.id, { name, plan }). Then count companies instead of people anywhere: aggregate by company in trends, funnels, retention, experiments and revenue.",
          null,
          { icon: 'layers', title: 'No groups yet' },
        );
      }
      return groupList(route, r.types);
    }),
  ];
}
