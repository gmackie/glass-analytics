/**
 * Cohort definitions, edited as groups of conditions: what people are (person
 * properties) and what they did (an event, how often, regularly, for the first
 * time, stopped or started, one event then another), or membership of another
 * cohort. Groups match all or any of their conditions, and the cohort all or
 * any of its groups. Edits the definition in place, like the other editors.
 */

import { type Child, h, mount } from '../dom.ts';
import { cleanFilters, type FilterRow, filterEditor } from './filter-editor.ts';
import { icon } from './icons.ts';
import { eventPicker } from './picker.ts';

type Condition = { type: string } & Record<string, unknown>;

interface CohortGroup {
  match?: 'all' | 'any';
  conditions: Condition[];
}

export interface CohortDefinition {
  match?: 'all' | 'any';
  groups: CohortGroup[];
  from?: string | number;
}

export interface CohortChoice {
  key: string;
  name: string;
}

const TYPES: [string, string][] = [
  ['performed', 'Did an event'],
  ['not_performed', 'Didn’t do an event'],
  ['property', 'Has a person property'],
  ['performed_regularly', 'Did an event regularly'],
  ['first_performed', 'Did an event for the first time'],
  ['stopped', 'Stopped doing an event'],
  ['started', 'Started doing an event'],
  ['sequence', 'Did one event, then another'],
  ['cohort', 'Is in another cohort'],
];

/** A new condition of a type, with sensible windows filled in. */
function newCondition(type: string): Condition {
  switch (type) {
    case 'property':
      return { type, property: '', op: 'eq', value: '' };
    case 'performed_regularly':
      return { type, event: '', period: 'week', periods: 4, minPeriods: 3 };
    case 'stopped':
      return { type, event: '', within: '14d' };
    case 'started':
      return { type, event: '', within: '7d' };
    case 'sequence':
      return { type, event: '', followedBy: { event: '' }, gap: '1d', within: '30d' };
    case 'cohort':
      return { type, key: '' };
    default:
      return { type, event: '', within: '30d' };
  }
}

export function emptyDefinition(): CohortDefinition {
  return { match: 'all', groups: [{ match: 'all', conditions: [newCondition('performed')] }] };
}

const words = (text: string) => h('span', { class: 'cohort-words' }, text);

function select(
  value: string,
  options: [string, string][],
  onChange: (v: string) => void,
  label: string,
): HTMLSelectElement {
  const el = h(
    'select',
    { class: 'short-select', 'aria-label': label },
    options.map(([v, l]) => h('option', { value: v, selected: v === value }, l)),
  );
  el.addEventListener('change', () => onChange(el.value));
  return el;
}

function numberInput(
  value: unknown,
  onChange: (n: number) => void,
  label: string,
  min = 0,
): HTMLInputElement {
  const el = h('input', {
    type: 'number',
    class: 'tiny',
    min,
    step: 1,
    value: value === undefined ? '' : String(value),
    'aria-label': label,
  });
  el.addEventListener('input', () => {
    if (el.value !== '') onChange(Math.max(min, Math.floor(Number(el.value))));
  });
  return el;
}

const UNITS: [string, string][] = [
  ['h', 'hours'],
  ['d', 'days'],
  ['w', 'weeks'],
  ['mo', 'months'],
];

/** A length of time as a number and a unit ("30d"); calls back with the duration string. */
function durationInput(
  value: unknown,
  fallback: string,
  onChange: (v: string) => void,
  label: string,
): HTMLElement {
  const m = /^(\d+)\s*(h|d|w|mo)$/i.exec(String(value ?? fallback)) ??
    /^(\d+)\s*(h|d|w|mo)$/i.exec(fallback) ?? ['', '30', 'd'];
  let n = m[1]!;
  let unit = m[2]!.toLowerCase();
  const emit = () => onChange(`${n}${unit}`);
  const amount = h('input', {
    type: 'number',
    class: 'tiny',
    min: 1,
    step: 1,
    value: n,
    'aria-label': `${label}: how many`,
  });
  amount.addEventListener('input', () => {
    if (Number(amount.value) >= 1) {
      n = String(Math.floor(Number(amount.value)));
      emit();
    }
  });
  return h(
    'span',
    { class: 'cohort-duration' },
    amount,
    select(
      unit,
      UNITS,
      (v) => {
        unit = v;
        emit();
      },
      `${label}: unit`,
    ),
  );
}

function eventField(
  target: Record<string, unknown>,
  project: string | undefined,
  repaint: () => void,
  label = 'Event',
): HTMLElement {
  const picker = eventPicker({
    value: String(target.event ?? ''),
    project,
    label,
    placeholder: 'Select an event',
    anyEvent: true,
    onChange: (v) => {
      if (v === target.event) return;
      target.event = v;
      delete target.filters;
      repaint();
    },
  });
  return h('div', { class: 'cohort-event' }, picker);
}

/** "where …" filters on the condition's event (optional). */
function eventFilters(
  target: Record<string, unknown>,
  project: string | undefined,
  onChange: () => void,
): HTMLElement | null {
  if (!target.event || target.event === '*') return null;
  const rows = (target.filters as FilterRow[] | undefined) ?? [];
  target.filters = rows;
  return h(
    'div',
    { class: 'cohort-event-filters' },
    filterEditor(rows, onChange, { project, event: String(target.event) }),
  );
}

interface ConditionContext {
  c: Condition;
  project: string | undefined;
  cohorts: CohortChoice[];
  repaint: () => void;
  onChange: () => void;
  /** A setter for one key that also reports the change. */
  set: (key: string) => (v: unknown) => void;
}

const sentence = (...children: Child[]) => h('div', { class: 'cohort-sentence' }, ...children);

function performedBody({ c, project, repaint, onChange, set }: ConditionContext): Child[] {
  const count = (c.count as { op: string; value: number } | undefined) ?? { op: 'gte', value: 1 };
  c.count = count;
  const op = select(
    count.op,
    [
      ['gte', 'at least'],
      ['eq', 'exactly'],
      ['lte', 'at most'],
    ],
    (v) => {
      count.op = v;
      onChange();
    },
    'How many times',
  );
  const times = numberInput(
    count.value,
    (n) => {
      count.value = n;
      onChange();
    },
    'Times',
  );
  return [
    sentence(
      eventField(c, project, repaint),
      op,
      times,
      words('times in the last'),
      durationInput(c.within, '30d', set('within'), 'Window'),
    ),
    eventFilters(c, project, onChange),
  ];
}

function inWindowBody({ c, project, repaint, onChange, set }: ConditionContext): Child[] {
  return [
    sentence(
      eventField(c, project, repaint),
      words(c.type === 'first_performed' ? 'for the first time in the last' : 'in the last'),
      durationInput(c.within, '30d', set('within'), 'Window'),
    ),
    eventFilters(c, project, onChange),
  ];
}

function regularlyBody({ c, project, repaint, onChange, set }: ConditionContext): Child[] {
  const period = select(
    String(c.period ?? 'week'),
    [
      ['day', 'days'],
      ['week', 'weeks'],
      ['month', 'months'],
    ],
    set('period'),
    'Period',
  );
  return [
    sentence(
      eventField(c, project, repaint),
      words('in at least'),
      numberInput(c.minPeriods, set('minPeriods'), 'Periods with the event', 1),
      words('of the last'),
      numberInput(c.periods, set('periods'), 'Periods to look at', 1),
      period,
    ),
    eventFilters(c, project, onChange),
  ];
}

function stoppedBody({ c, project, repaint, onChange, set }: ConditionContext): Child[] {
  // The earlier window defaults to the recent one's length; set it so the form shows what runs.
  if (c.before === undefined) c.before = c.within;
  return [
    sentence(
      eventField(c, project, repaint),
      words('in the'),
      durationInput(c.before, '14d', set('before'), 'Earlier window'),
      words('before, but not in the last'),
      durationInput(c.within, '14d', set('within'), 'Recent window'),
    ),
    eventFilters(c, project, onChange),
  ];
}

function startedBody({ c, project, repaint, onChange, set }: ConditionContext): Child[] {
  if (c.before === undefined) c.before = c.within;
  return [
    sentence(
      eventField(c, project, repaint),
      words('in the last'),
      durationInput(c.within, '7d', set('within'), 'Recent window'),
      words('but not in the'),
      durationInput(c.before, '7d', set('before'), 'Earlier window'),
      words('before'),
    ),
    eventFilters(c, project, onChange),
  ];
}

function sequenceBody({ c, project, repaint, set }: ConditionContext): Child[] {
  const next = (c.followedBy as Record<string, unknown> | undefined) ?? { event: '' };
  c.followedBy = next;
  return [
    sentence(
      eventField(c, project, repaint, 'First event'),
      words('then'),
      eventField(next, project, repaint, 'Then event'),
      words('within'),
      durationInput(c.gap, '1d', set('gap'), 'Gap'),
      words('in the last'),
      durationInput(c.within, '30d', set('within'), 'Window'),
    ),
  ];
}

function cohortBody({ c, cohorts, onChange, set }: ConditionContext): Child[] {
  const choices = cohorts.filter((x) => x.key);
  const inOut = select(
    c.negate ? 'out' : 'in',
    [
      ['in', 'is in'],
      ['out', 'is not in'],
    ],
    (v) => {
      if (v === 'out') c.negate = true;
      else delete c.negate;
      onChange();
    },
    'In or not in',
  );
  const which = choices.length
    ? select(
        String(c.key ?? ''),
        [['', 'Choose a cohort'], ...choices.map((x): [string, string] => [x.key, x.name])],
        set('key'),
        'Cohort',
      )
    : h('span', { class: 'muted small' }, 'Save another cohort first.');
  return [sentence(inOut, which)];
}

function propertyBody({ c, project, onChange }: ConditionContext): Child[] {
  return [
    h(
      'div',
      { class: 'cohort-property' },
      filterEditor([c as unknown as FilterRow], onChange, {
        project,
        personOnly: true,
        single: true,
      }),
    ),
  ];
}

const CONDITION_BODIES: Record<string, (ctx: ConditionContext) => Child[]> = {
  property: propertyBody,
  performed: performedBody,
  not_performed: inWindowBody,
  first_performed: inWindowBody,
  performed_regularly: regularlyBody,
  stopped: stoppedBody,
  started: startedBody,
  sequence: sequenceBody,
  cohort: cohortBody,
};

function conditionBody(
  c: Condition,
  project: string | undefined,
  cohorts: CohortChoice[],
  repaint: () => void,
  onChange: () => void,
): Child[] {
  const set = (key: string) => (v: unknown) => {
    c[key] = v;
    onChange();
  };
  const body = CONDITION_BODIES[c.type];
  if (!body) return [h('span', { class: 'muted small' }, `Unknown condition "${c.type}"`)];
  return body({ c, project, cohorts, repaint, onChange, set });
}

function groupCard(
  group: CohortGroup,
  index: number,
  def: CohortDefinition,
  project: string | undefined,
  cohorts: CohortChoice[],
  repaintAll: () => void,
  onChange: () => void,
): HTMLElement {
  const card = h('div', { class: 'cohort-group' });
  const paint = () => {
    mount(
      card,
      h(
        'div',
        { class: 'cohort-group-head' },
        h(
          'span',
          { class: 'cohort-group-title' },
          def.groups.length > 1 ? `Group ${index + 1}` : 'People who',
        ),
        group.conditions.length > 1
          ? [
              words('match'),
              select(
                group.match ?? 'all',
                [
                  ['all', 'all'],
                  ['any', 'any'],
                ],
                (v) => {
                  group.match = v as 'all' | 'any';
                  paint();
                  onChange();
                },
                'Match all or any condition',
              ),
              words('of these'),
            ]
          : null,
        def.groups.length > 1
          ? h(
              'button',
              {
                type: 'button',
                class: 'icon-button push-right',
                'aria-label': `Remove group ${index + 1}`,
                title: 'Remove group',
                onclick: () => {
                  def.groups.splice(index, 1);
                  repaintAll();
                  onChange();
                },
              },
              icon('trash', 14),
            )
          : null,
      ),
      group.conditions.map((c, i) =>
        h(
          'div',
          { class: 'cohort-condition' },
          h(
            'div',
            { class: 'cohort-condition-head' },
            i > 0
              ? h('span', { class: 'cohort-joiner' }, group.match === 'any' ? 'or' : 'and')
              : null,
            select(
              c.type,
              TYPES,
              (v) => {
                group.conditions[i] = newCondition(v);
                paint();
                onChange();
              },
              'Condition type',
            ),
            group.conditions.length > 1 || def.groups.length > 1
              ? h(
                  'button',
                  {
                    type: 'button',
                    class: 'icon-button push-right',
                    'aria-label': 'Remove condition',
                    title: 'Remove condition',
                    onclick: () => {
                      group.conditions.splice(i, 1);
                      if (!group.conditions.length) def.groups.splice(index, 1);
                      repaintAll();
                      onChange();
                    },
                  },
                  icon('x', 14),
                )
              : null,
          ),
          conditionBody(
            c,
            project,
            cohorts,
            () => {
              paint();
              onChange();
            },
            onChange,
          ),
        ),
      ),
      h(
        'button',
        {
          type: 'button',
          class: 'link-button add-button',
          onclick: () => {
            group.conditions.push(newCondition('performed'));
            paint();
            onChange();
          },
        },
        icon('plus', 14),
        'Add condition',
      ),
    );
  };
  paint();
  return card;
}

const LOOK_BACK: [string, string][] = [
  ['-30d', '30 days'],
  ['-90d', '90 days'],
  ['-180d', '180 days'],
  ['-365d', 'year'],
  ['-730d', '2 years'],
];

/**
 * The whole definition: groups, the match between them, and how far back
 * people are considered. `cohorts` are the others it may reference.
 */
export function cohortEditor(
  def: CohortDefinition,
  project: string | undefined,
  cohorts: CohortChoice[],
  onChange: () => void,
): HTMLElement {
  const root = h('div', { class: 'cohort-editor' });
  const paint = () => {
    mount(
      root,
      def.groups.map((g, i) => [
        i > 0
          ? h(
              'div',
              { class: 'cohort-between' },
              select(
                def.match ?? 'all',
                [
                  ['all', 'and'],
                  ['any', 'or'],
                ],
                (v) => {
                  def.match = v as 'all' | 'any';
                  paint();
                  onChange();
                },
                'Match all or any group',
              ),
            )
          : null,
        groupCard(g, i, def, project, cohorts, paint, onChange),
      ]),
      h(
        'div',
        { class: 'row cohort-editor-foot' },
        h(
          'button',
          {
            type: 'button',
            class: 'link-button add-button',
            onclick: () => {
              def.groups.push({ match: 'all', conditions: [newCondition('performed')] });
              paint();
              onChange();
            },
          },
          icon('plus', 14),
          def.groups.length ? 'Add a group (and / or)' : 'Add a group',
        ),
        h(
          'span',
          { class: 'push-right row' },
          words('Among people seen in the last'),
          select(
            String(def.from ?? '-90d'),
            LOOK_BACK.some(([v]) => v === String(def.from ?? '-90d'))
              ? LOOK_BACK
              : [[String(def.from), String(def.from)], ...LOOK_BACK],
            (v) => {
              def.from = v;
              onChange();
            },
            'Look-back',
          ),
        ),
      ),
    );
  };
  paint();
  return root;
}

const BEHAVIOUR = new Set([
  'performed',
  'not_performed',
  'performed_regularly',
  'first_performed',
  'stopped',
  'started',
  'sequence',
]);

/** One condition ready to send, or null while it is incomplete. */
/** A behaviour condition without its defaults, or null when it's unfinished. */
function completeBehaviour(c: Condition): Condition | null {
  if (!BEHAVIOUR.has(c.type) || !c.event) return null;
  if (c.type === 'sequence' && !(c.followedBy as { event?: string } | undefined)?.event)
    return null;
  const out: Condition = { ...c };
  const filters = cleanFilters(c.filters as FilterRow[] | undefined);
  if (filters?.length) out.filters = filters;
  else delete out.filters;
  const count = c.count as { op: string; value: number } | undefined;
  if (c.type === 'performed' && (!count || (count.op === 'gte' && count.value === 1)))
    delete out.count;
  return out;
}

function completeCondition(c: Condition): Condition | null {
  if (c.type === 'property') {
    const [row] = cleanFilters([c as unknown as FilterRow]) ?? [];
    if (!row) return null;
    return { type: 'property', ...row, ...(c.negate ? { negate: true } : {}) };
  }
  if (c.type === 'cohort') return c.key ? { ...c } : null;
  return completeBehaviour(c);
}

/** The definition ready to send: incomplete conditions and empty groups left out. */
export function completeDefinition(def: CohortDefinition): CohortDefinition | null {
  const groups = def.groups
    .map((g) => ({
      ...(g.match === 'any' ? { match: 'any' as const } : {}),
      conditions: g.conditions.map(completeCondition).filter((c): c is Condition => c !== null),
    }))
    .filter((g) => g.conditions.length);
  if (!groups.length) return null;
  return {
    ...(def.match === 'any' ? { match: 'any' as const } : {}),
    groups,
    ...(def.from ? { from: def.from } : {}),
  };
}
