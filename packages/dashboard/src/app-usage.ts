import { createAppUsage, dashboardScreen } from '@dataflare/core/app-usage';
import type { Dataflare } from '../../web/src/client.ts';
import { config, type Route } from './state.ts';

let sdk: Dataflare | undefined;
// The SDK invokes beforeSend synchronously inside capture. Only our typed events may use this client.
let productProps: Record<string, string | boolean> | undefined;
export const dashboardUsage = createAppUsage(
  'web',
  navigator.webdriver ? 'verification' : 'usage',
  (event, props) => {
    productProps = props;
    try {
      sdk?.capture(event, props);
    } finally {
      productProps = undefined;
    }
  },
);

/** The configured Worker serves its own script-tag SDK, without its auto-init data attribute. */
export function startUsage(): void {
  if (!config.usageProject) return;
  const glass = (window as Window & { glass?: Dataflare }).glass;
  if (!glass || sdk) return;
  sdk = glass.init({
    host: location.origin + config.base,
    project: config.usageProject,
    autocapture: false,
    flags: false,
    webExperiments: false,
    replay: false,
    beforeSend: ({ id, ts, event, distinct_id, session_id }) =>
      productProps
        ? {
            id,
            ts,
            event,
            distinct_id,
            session_id,
            url: location.origin + config.base + '/app/' + productProps.screen,
            props: productProps,
          }
        : null,
  });
  dashboardUsage.open('live');
}

export function visitDashboard(route: Route): void {
  if (!sdk) return;
  dashboardUsage.visit(
    dashboardScreen(route.page, route.rest),
    'live',
    JSON.stringify([route.page, ...route.rest, route.params.get('project')]),
  );
}
