/**
 * Amplitude-style event and property pickers: searchable list with a detail
 * side panel (description, properties, examples).
 */

import {
  type CatalogEvent,
  type CatalogEventDetail,
  type CatalogProperty,
  COLUMN_OPTIONS,
  loadEventDetail,
  loadEvents,
  loadPersonProperties,
} from '../catalog.ts';
import { type Child, h, mount } from '../dom.ts';
import { count, percent } from '../format.ts';
import { href, scope } from '../state.ts';

export interface EventPickerOptions {
  value: string;
  onChange: (event: string) => void;
  /** Called when the selected event's detail loads (useful to refresh property pickers). */
  onDetail?: (detail: CatalogEventDetail) => void;
  label?: string;
  project?: string;
  placeholder?: string;
  /** Offer "Any event" (the value "*") at the top. */
  anyEvent?: boolean;
}

export interface PropertyPickerOptions {
  value: string;
  onChange: (property: string) => void;
  /** Prefer properties of this event in the list. */
  event?: string;
  project?: string;
  /** Include built-in columns (breakdowns). Default true. */
  columns?: boolean;
  /** Include properties seen on `event`. Default true. */
  eventProperties?: boolean;
  /** Include person properties (person.*). Default true. */
  person?: boolean;
  /** Offer "Cohort" (saved-cohort membership) at the top. Default false. */
  cohorts?: boolean;
  /** Allow free-typed person.* / custom props. Default true. */
  allowCustom?: boolean;
  /** Prefix for free-typed names, e.g. "person." so "plan" becomes "person.plan". */
  customPrefix?: string;
  /** Show a "No property" row that clears the value. */
  clearable?: boolean;
  label?: string;
  placeholder?: string;
}

type ListItem = {
  id: string;
  label: string;
  meta?: string;
  group: string;
  search: string;
};

export function closeActivePicker(): void {
  for (const el of document.querySelectorAll('.picker-pop')) el.remove();
  for (const el of document.querySelectorAll('.picker.open')) el.classList.remove('open');
}

export function positionPop(trigger: HTMLElement, pop: HTMLElement, maxWidth = 680): void {
  const rect = trigger.getBoundingClientRect();
  const width = Math.min(maxWidth, Math.max(Math.min(420, maxWidth), window.innerWidth - 24));
  let left = rect.left;
  if (left + width > window.innerWidth - 12) left = Math.max(12, window.innerWidth - width - 12);
  let top = rect.bottom + 6;
  const height = 380;
  if (top + height > window.innerHeight - 12) top = Math.max(12, rect.top - height - 6);
  pop.style.width = `${width}px`;
  pop.style.left = `${Math.round(left)}px`;
  pop.style.top = `${Math.round(top)}px`;
}

const display = (value: string) =>
  value === 'cohort' ? 'Cohort' : value === '*' ? 'Any event' : value;

function triggerButton(value: string, placeholder: string, open: () => void): HTMLButtonElement {
  const empty = !value;
  const btn = h(
    'button',
    {
      type: 'button',
      class: `picker-trigger${empty ? ' empty' : ''}`,
      'aria-haspopup': 'listbox',
      'aria-expanded': 'false',
    },
    h('span', { class: 'picker-trigger-value' }, empty ? placeholder : display(value)),
    h('span', { class: 'picker-chevron', 'aria-hidden': 'true' }, '▾'),
  );
  btn.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    open();
  });
  return btn;
}

function detailShell(): { root: HTMLElement; show: (content: Child) => void } {
  const root = h('aside', { class: 'picker-detail', 'aria-live': 'polite' });
  return {
    root,
    show: (content) => mount(root, content),
  };
}

function emptyDetail(message: string): HTMLElement {
  return h('div', { class: 'picker-detail-empty' }, h('p', { class: 'muted' }, message));
}

function eventDetailView(detail: CatalogEventDetail, listRow?: CatalogEvent): Child {
  return [
    h(
      'div',
      { class: 'picker-detail-head' },
      h('h3', {}, detail.event),
      listRow ? h('span', { class: 'muted' }, `${count(listRow.count)} in 30d`) : null,
    ),
    detail.description
      ? h('p', { class: 'picker-detail-desc' }, detail.description)
      : h(
          'p',
          { class: 'muted' },
          'No description yet. Document this event under Events so agents know when it fires.',
        ),
    detail.owner ? h('p', { class: 'muted small' }, `Owner: ${detail.owner}`) : null,
    detail.properties.length
      ? h(
          'div',
          { class: 'picker-detail-props' },
          h('h4', {}, 'Properties'),
          h(
            'ul',
            {},
            detail.properties
              .slice(0, 12)
              .map((p) =>
                h(
                  'li',
                  {},
                  h('code', {}, p.name),
                  h('span', { class: 'muted' }, p.types.join('|') || '—'),
                  h(
                    'span',
                    { class: 'picker-detail-prop-desc' },
                    p.description ||
                      (p.examples.length ? `e.g. ${p.examples.slice(0, 3).join(', ')}` : ''),
                  ),
                ),
              ),
          ),
          detail.properties.length > 12
            ? h('p', { class: 'muted small' }, `+${detail.properties.length - 12} more`)
            : null,
        )
      : h('p', { class: 'muted small' }, 'No custom properties seen on recent events.'),
    h(
      'a',
      { class: 'picker-detail-link', href: href(`events/${encodeURIComponent(detail.event)}`) },
      'Open in Events',
    ),
  ];
}

function propertyDetailView(
  p:
    | CatalogProperty
    | {
        name: string;
        description: string;
        types?: string[];
        coverage?: number;
        examples?: string[];
      },
): Child {
  return [
    h('div', { class: 'picker-detail-head' }, h('h3', {}, p.name)),
    h(
      'p',
      { class: 'picker-detail-desc' },
      p.description || 'No description for this property yet.',
    ),
    p.types?.length
      ? h(
          'p',
          { class: 'muted small' },
          `Type: ${p.types.join(', ')}${p.coverage != null ? ` · ${percent(p.coverage, 0)} of recent events` : ''}`,
        )
      : null,
    p.examples?.length
      ? h('p', { class: 'muted small' }, `Examples: ${p.examples.slice(0, 5).join(', ')}`)
      : null,
  ];
}

function renderList(
  listEl: HTMLElement,
  items: ListItem[],
  selectedId: string,
  activeId: string,
  onHover: (id: string) => void,
  onPick: (id: string) => void,
): void {
  let lastGroup = '';
  const nodes: Child[] = [];
  if (items.length === 0) {
    nodes.push(h('p', { class: 'picker-empty muted' }, 'No matches.'));
  }
  for (const item of items) {
    if (item.group !== lastGroup) {
      lastGroup = item.group;
      if (item.group.trim()) nodes.push(h('div', { class: 'picker-group-label' }, item.group));
    }
    nodes.push(
      h(
        'button',
        {
          type: 'button',
          class: `picker-item${item.id === selectedId ? ' selected' : ''}${item.id === activeId ? ' active' : ''}`,
          role: 'option',
          'aria-selected': String(item.id === selectedId),
          'data-id': item.id,
          onmouseenter: () => onHover(item.id),
          onclick: (e) => {
            e.preventDefault();
            onPick(item.id);
          },
        },
        h('span', { class: 'picker-item-name' }, item.label),
        item.meta ? h('span', { class: 'picker-item-meta' }, item.meta) : null,
      ),
    );
  }
  mount(listEl, nodes);
  listEl
    .querySelector<HTMLElement>('.picker-item.active, .picker-item.selected')
    ?.scrollIntoView({ block: 'nearest' });
}

/** Event name combobox with list + description side panel. */
export function eventPicker(options: EventPickerOptions): HTMLElement {
  const project = options.project ?? scope().project;
  const placeholder = options.placeholder ?? 'Select an event';
  const root = h('div', { class: 'picker', 'aria-label': options.label ?? 'Event' });
  const trigger = triggerButton(options.value, placeholder, () => open());
  root.append(trigger);

  let events: CatalogEvent[] = [];
  let query = '';
  let activeId = options.value;
  let detailReq = 0;

  const open = () => {
    closeActivePicker();
    root.classList.add('open');
    trigger.setAttribute('aria-expanded', 'true');

    const search = h('input', {
      type: 'search',
      class: 'picker-search',
      placeholder: 'Search events…',
      value: query,
      'aria-label': 'Search events',
      autocomplete: 'off',
    }) as HTMLInputElement;
    const listEl = h('div', { class: 'picker-list', role: 'listbox' });
    const detail = detailShell();
    const pop = h(
      'div',
      { class: 'picker-pop', role: 'dialog', 'aria-label': 'Choose an event' },
      search,
      h('div', { class: 'picker-body' }, listEl, detail.root),
    );
    document.body.append(pop);
    positionPop(trigger, pop);
    search.focus();

    const items = (): ListItem[] => {
      const q = query.trim().toLowerCase();
      const filtered = events.filter(
        (e) => !q || e.event.toLowerCase().includes(q) || e.description.toLowerCase().includes(q),
      );
      const custom = events.filter((e) => !e.system);
      const system = events.filter((e) => e.system);
      const order = [...custom, ...system].filter((e) => filtered.includes(e));
      const rows: ListItem[] = order.map((e) => ({
        id: e.event,
        label: e.event,
        meta: count(e.count),
        group: e.system ? 'Built-in' : 'Your events',
        search: `${e.event} ${e.description}`.toLowerCase(),
      }));
      if (q && !events.some((e) => e.event.toLowerCase() === q)) {
        rows.unshift({
          id: query.trim(),
          label: `Use “${query.trim()}”`,
          meta: 'new',
          group: 'Custom',
          search: q,
        });
      }
      if (options.anyEvent && (!q || 'any event'.includes(q) || q === '*'))
        rows.unshift({ id: '*', label: 'Any event', group: 'Any', search: 'any event *' });
      return rows;
    };

    const showDetail = (id: string) => {
      activeId = id;
      const row = events.find((e) => e.event === id);
      if (!id) {
        detail.show(emptyDetail('Hover an event to see its description and properties.'));
        return;
      }
      if (id === '*') {
        detail.show(emptyDetail('Any event: counts everything they did.'));
        return;
      }
      const req = ++detailReq;
      detail.show(h('div', { class: 'picker-detail-loading muted' }, 'Loading…'));
      void loadEventDetail(id, project).then((d) => {
        if (req !== detailReq) return;
        options.onDetail?.(d);
        detail.show(eventDetailView(d, row));
      });
    };

    const refresh = () => {
      const rows = items();
      if (!rows.some((r) => r.id === activeId)) activeId = rows[0]?.id ?? '';
      renderList(listEl, rows, options.value, activeId, showDetail, pick);
      if (activeId) showDetail(activeId);
      else detail.show(emptyDetail('Hover an event to see its description and properties.'));
    };

    const pick = (id: string) => {
      options.onChange(id);
      mount(trigger.querySelector('.picker-trigger-value')!, id ? display(id) : placeholder);
      trigger.classList.toggle('empty', !id);
      cleanup();
    };

    const onKey = (e: KeyboardEvent) => {
      const rows = items();
      const idx = rows.findIndex((r) => r.id === activeId);
      if (e.key === 'Escape') {
        e.preventDefault();
        cleanup();
      } else if (e.key === 'ArrowDown') {
        e.preventDefault();
        activeId = rows[Math.min(rows.length - 1, idx + 1)]?.id ?? activeId;
        refresh();
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        activeId = rows[Math.max(0, idx - 1)]?.id ?? activeId;
        refresh();
      } else if (e.key === 'Enter') {
        e.preventDefault();
        if (activeId) pick(activeId);
      }
    };

    const onDoc = (e: MouseEvent) => {
      if (e.target instanceof Node && (pop.contains(e.target) || root.contains(e.target))) return;
      cleanup();
    };

    const cleanup = () => {
      pop.remove();
      root.classList.remove('open');
      trigger.setAttribute('aria-expanded', 'false');
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('resize', onResize);
      document.removeEventListener('mousedown', onDoc, true);
    };

    const onResize = () => positionPop(trigger, pop);
    search.addEventListener('input', () => {
      query = search.value;
      refresh();
    });
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('resize', onResize);
    document.addEventListener('mousedown', onDoc, true);

    detail.show(emptyDetail('Loading events…'));
    void loadEvents(project).then((list) => {
      events = list;
      if (!activeId && options.value) activeId = options.value;
      refresh();
    });
  };

  return root;
}

const COHORT_DOC =
  'People in (or not in) a saved cohort. Pick the cohorts as values; define cohorts on the People tab.';

/** Property combobox: cohorts, event props, person props and built-in columns. */
export function propertyPicker(options: PropertyPickerOptions): HTMLElement {
  const project = options.project ?? scope().project;
  const includeColumns = options.columns !== false;
  const allowCustom = options.allowCustom !== false;
  const clearable = options.clearable === true;
  const includeEvent = options.eventProperties !== false;
  const includePerson = options.person !== false;
  const includeCohorts = options.cohorts === true;
  const placeholder = options.placeholder ?? 'Select a property';
  const root = h('div', { class: 'picker', 'aria-label': options.label ?? 'Property' });
  const trigger = triggerButton(options.value, placeholder, () => open());
  root.append(trigger);

  let eventProps: CatalogProperty[] = [];
  let personProps: CatalogProperty[] = [];
  let query = '';
  let activeId = options.value;

  const open = () => {
    closeActivePicker();
    root.classList.add('open');
    trigger.setAttribute('aria-expanded', 'true');

    const search = h('input', {
      type: 'search',
      class: 'picker-search',
      placeholder: 'Search properties…',
      value: query,
      'aria-label': 'Search properties',
      autocomplete: 'off',
    }) as HTMLInputElement;
    const listEl = h('div', { class: 'picker-list', role: 'listbox' });
    const detail = detailShell();
    const pop = h(
      'div',
      { class: 'picker-pop', role: 'dialog', 'aria-label': 'Choose a property' },
      search,
      h('div', { class: 'picker-body' }, listEl, detail.root),
    );
    document.body.append(pop);
    positionPop(trigger, pop);
    search.focus();

    const allItems = (): ListItem[] => {
      const rows: ListItem[] = [];
      if (clearable) {
        rows.push({
          id: '',
          label: 'No property',
          meta: 'clear',
          group: ' ',
          search: 'none clear optional',
        });
      }
      if (includeCohorts) {
        rows.push({
          id: 'cohort',
          label: 'Cohort',
          meta: 'in / not in',
          group: 'Cohorts',
          search: `cohort segment ${COHORT_DOC}`.toLowerCase(),
        });
      }
      for (const p of eventProps) {
        rows.push({
          id: p.name,
          label: p.name,
          meta: p.types[0] ?? '',
          group: options.event ? `On ${options.event}` : 'Event properties',
          search: `${p.name} ${p.description} ${p.examples.join(' ')}`.toLowerCase(),
        });
      }
      for (const p of personProps) {
        rows.push({
          id: p.name,
          label: p.name,
          meta: p.types[0] ?? '',
          group: 'Person properties',
          search: `${p.name} ${p.examples.join(' ')}`.toLowerCase(),
        });
      }
      if (includeColumns) {
        for (const c of COLUMN_OPTIONS) {
          rows.push({
            id: c.name,
            label: c.name,
            meta: c.group,
            group: 'Built-in columns',
            search: `${c.name} ${c.description} ${c.group}`.toLowerCase(),
          });
        }
      }
      return rows;
    };

    const items = (): ListItem[] => {
      const q = query.trim().toLowerCase();
      const rows = allItems().filter(
        (r) => !q || r.search.includes(q) || r.id.toLowerCase().includes(q),
      );
      const prefix = options.customPrefix ?? '';
      const typed =
        prefix && !query.trim().startsWith(prefix) ? `${prefix}${query.trim()}` : query.trim();
      if (allowCustom && q && !rows.some((r) => r.id.toLowerCase() === typed.toLowerCase())) {
        const label = typed.startsWith('person.') ? `Person property “${typed}”` : `Use “${typed}”`;
        rows.unshift({ id: typed, label, meta: 'custom', group: 'Custom', search: q });
      }
      return rows;
    };

    const showDetail = (id: string) => {
      activeId = id;
      if (!id) {
        detail.show(emptyDetail('Leave empty for no breakdown or aggregation property.'));
        return;
      }
      if (id === 'cohort' && includeCohorts) {
        detail.show(propertyDetailView({ name: 'Cohort', description: COHORT_DOC }));
        return;
      }
      const prop = eventProps.find((p) => p.name === id) ?? personProps.find((p) => p.name === id);
      if (prop) {
        detail.show(propertyDetailView(prop));
        return;
      }
      const col = COLUMN_OPTIONS.find((c) => c.name === id);
      if (col) {
        detail.show(
          propertyDetailView({ name: col.name, description: col.description, types: ['string'] }),
        );
        return;
      }
      if (id.startsWith('person.')) {
        detail.show(
          propertyDetailView({
            name: id,
            description: `Person property “${id.slice(7)}” as of the event time. Set via glass.identify() or $set.`,
          }),
        );
        return;
      }
      detail.show(
        propertyDetailView({
          name: id,
          description: 'Custom event property (looked up on props).',
        }),
      );
    };

    const refresh = () => {
      const rows = items();
      if (!rows.some((r) => r.id === activeId)) activeId = rows[0]?.id ?? '';
      renderList(listEl, rows, options.value, activeId, showDetail, pick);
      if (activeId) showDetail(activeId);
      else detail.show(emptyDetail('Hover a property to see its description.'));
    };

    const pick = (id: string) => {
      options.onChange(id);
      mount(trigger.querySelector('.picker-trigger-value')!, display(id) || placeholder);
      trigger.classList.toggle('empty', !id);
      cleanup();
    };

    const onKey = (e: KeyboardEvent) => {
      const rows = items();
      const idx = rows.findIndex((r) => r.id === activeId);
      if (e.key === 'Escape') {
        e.preventDefault();
        cleanup();
      } else if (e.key === 'ArrowDown') {
        e.preventDefault();
        activeId = rows[Math.min(rows.length - 1, idx + 1)]?.id ?? activeId;
        refresh();
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        activeId = rows[Math.max(0, idx - 1)]?.id ?? activeId;
        refresh();
      } else if (e.key === 'Enter') {
        e.preventDefault();
        if (activeId) pick(activeId);
      }
    };

    const onDoc = (e: MouseEvent) => {
      if (e.target instanceof Node && (pop.contains(e.target) || root.contains(e.target))) return;
      cleanup();
    };

    const cleanup = () => {
      pop.remove();
      root.classList.remove('open');
      trigger.setAttribute('aria-expanded', 'false');
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('resize', onResize);
      document.removeEventListener('mousedown', onDoc, true);
    };

    const onResize = () => positionPop(trigger, pop);
    search.addEventListener('input', () => {
      query = search.value;
      refresh();
    });
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('resize', onResize);
    document.addEventListener('mousedown', onDoc, true);

    detail.show(h('div', { class: 'picker-detail-loading muted' }, 'Loading properties…'));
    void Promise.all([
      includeEvent && options.event
        ? loadEventDetail(options.event, project).then((d) => d.properties)
        : Promise.resolve([]),
      includePerson ? loadPersonProperties(project) : Promise.resolve([]),
    ]).then(([event, person]) => {
      eventProps = event;
      personProps = person;
      refresh();
    });
  };

  return root;
}
