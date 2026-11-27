/** Product events for Dataflare's own dashboard and iPhone app. */
export type UsageMode = 'live' | 'demo';
type Report = 'overview' | 'paths';
const sections = [
  'sites',
  'overview',
  'insights',
  'paths',
  'dashboards',
  'product',
  'users',
  'groups',
  'replays',
  'errors',
  'revenue',
  'flags',
  'experiments',
  'events',
  'pipelines',
  'sql',
  'usage',
  'settings',
] as const;
type Screen = (typeof sections)[number] | 'other';
type Event =
  | 'app_opened'
  | '$pageview'
  | 'report_viewed'
  | 'path_detail_opened'
  | 'worker_connection';
type Props = Record<string, string | boolean>;

/** URL segments can contain saved insight names and person IDs. Only return known screen names. */
export function dashboardScreen(page: string, rest: readonly string[]): Screen {
  if (page === 'web' || page === 'reports') return 'overview';
  if (page === 'insights' && (rest[0] === 'paths' || (rest[0] === 'new' && rest[1] === 'paths')))
    return 'paths';
  return sections.find((name) => name === page) ?? 'other';
}

export function createAppUsage(
  surface: 'web' | 'ios',
  traffic: 'usage' | 'verification',
  send: (event: Event, props: Props) => void,
) {
  let opened = false;
  let current: { screen: Screen; mode: UsageMode; selection: string; report?: Report } | undefined;
  const emit = (event: Event, mode: UsageMode, screen: string, props?: Props) =>
    send(event, { surface, traffic, mode, screen, ...props });
  return {
    open(mode: UsageMode) {
      if (opened) return;
      opened = true;
      emit('app_opened', mode, 'app');
    },
    /** Selection is local to the view. Never include it in the wire event. */
    visit(screen: Screen, mode: UsageMode, selection = '') {
      if (current?.screen === screen && current.mode === mode && current.selection === selection)
        return;
      current = { screen, mode, selection };
      emit('$pageview', mode, screen);
    },
    /** Bind an asynchronous result to its visit. Ignore late replies and background refetches. */
    reportResult() {
      const visit = current;
      return (report: Report, hasData: boolean) => {
        if (!visit || visit !== current || visit.report === report) return;
        visit.report = report;
        emit('report_viewed', visit.mode, visit.screen, { report, has_data: hasData });
      };
    },
    detail(target: 'step' | 'transition') {
      if (current) emit('path_detail_opened', current.mode, current.screen, { target });
    },
    connection(mode: UsageMode, outcome: 'attempted' | 'connected' | 'failed') {
      emit('worker_connection', mode, 'connection', { outcome });
    },
    leave() {
      current = undefined;
    },
  };
}
