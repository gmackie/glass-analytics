/**
 * Settings (install snippets, agent setup, projects) and the key screen.
 */

import { api } from '../api.ts';
import { icon } from '../components/icons.ts';
import { notificationChannelsPanel } from '../components/notification-channels.ts';
import { projectSettingsPanels } from '../components/project-settings.ts';
import {
  copyButton,
  errorState,
  later,
  pageHeader,
  panel,
  table,
  toast,
} from '../components/ui.ts';
import { h, mount } from '../dom.ts';
import { dateTime } from '../format.ts';
import { config, prefs, scope } from '../state.ts';

const workerUrl = () => `${location.origin}${config.base}`;

function codeBlock(code: string): HTMLElement {
  return h('div', { class: 'code-block' }, h('pre', {}, h('code', {}, code)), copyButton(code));
}

function sessionControl(): HTMLElement {
  if (config.access)
    return h(
      'a',
      { class: 'button ghost small', href: '/cdn-cgi/access/logout' },
      icon('logout', 14),
      'Sign out of Cloudflare Access',
    );
  return h(
    'button',
    {
      type: 'button',
      class: 'ghost small',
      onclick: () => {
        prefs.key = null;
        location.reload();
      },
    },
    icon('logout', 14),
    'Forget this key',
  );
}

export function settingsPage(): Node[] {
  const project = scope().project ?? 'your-project';
  const host = workerUrl();
  return [
    pageHeader('Settings', undefined),
    h(
      'div',
      { class: 'grid-2' },
      panel(
        'Install on a site',
        [
          h(
            'p',
            {},
            'Add this to the <head> of every page. Pageviews, clicks, errors and web vitals are captured automatically.',
          ),
          codeBlock(`<script defer src="${host}/s.js" data-project="${project}"></script>`),
          h('p', {}, 'Then track what matters:'),
          codeBlock(
            `glass.capture('signup_completed', { plan: 'pro' });\nglass.identify(user.id, { plan: user.plan });`,
          ),
        ],
        { icon: 'code' },
      ),
      panel(
        'Connect an agent',
        [
          h(
            'p',
            {},
            'In a project set up with dataflare init, agents already have the MCP server. Elsewhere, add it by URL with your key:',
          ),
          codeBlock(
            `claude mcp add --transport http glass ${host}/mcp \\\n  --header "Authorization: Bearer $GLASS_API_KEY"`,
          ),
          h('p', {}, 'Agent instructions for this deployment:'),
          codeBlock(`${host}/llms.txt`),
        ],
        { icon: 'bot' },
      ),
    ),
    projectSettingsPanels(),
    notificationChannelsPanel(),
    later(async () => {
      const [health, projects] = await Promise.all([
        api.get<{
          version: string;
          latest?: string | null;
          upgradeAvailable?: boolean;
          upgradeCommand?: string;
          store: string;
          replay: boolean;
          freshnessSeconds: number;
        }>('/health'),
        api.get<{
          projects: { id: string; name: string; createdAt: number; allowedOrigins: string[] }[];
        }>('/api/projects'),
      ]);
      const id = h('input', {
        type: 'text',
        required: true,
        placeholder: 'acme-docs',
        pattern: '[a-z0-9][a-z0-9_-]*',
      });
      const error = h('div', {});
      const form = h(
        'form',
        { class: 'inline-form' },
        id,
        h('button', { type: 'submit', class: 'ghost' }, icon('plus', 14), 'Add project'),
        error,
      );
      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        try {
          await api.post('/api/projects', { id: id.value });
          toast(`Project ${id.value} added`);
          location.reload();
        } catch (err) {
          mount(error, errorState(err));
        }
      });
      return h(
        'div',
        { class: 'grid-2 settings-lower' },
        panel(
          'Projects',
          [
            table(
              ['Project', 'Created', 'Allowed origins'],
              projects.projects.map((p) => [
                h('code', {}, p.id),
                dateTime(p.createdAt),
                p.allowedOrigins.join(', ') || h('span', { class: 'muted' }, 'Any'),
              ]),
            ),
            form,
          ],
          { icon: 'layers' },
        ),
        panel(
          'This deployment',
          [
            health.upgradeAvailable && health.latest
              ? h(
                  'p',
                  { class: 'notice' },
                  `Dataflare ${health.latest} is available. Run `,
                  h(
                    'code',
                    {},
                    health.upgradeCommand ?? 'npx @gmacko/dataflare-cli@latest upgrade',
                  ),
                  ` in your project.`,
                )
              : null,
            h(
              'dl',
              { class: 'props' },
              h('dt', {}, 'Version'),
              h(
                'dd',
                {},
                health.latest && health.latest !== health.version
                  ? `${health.version} (latest ${health.latest})`
                  : health.version,
              ),
              h('dt', {}, 'Event store'),
              h(
                'dd',
                {},
                health.store === 'lake'
                  ? `Iceberg lake (data appears after about ${Math.round(health.freshnessSeconds / 60)} min)`
                  : 'D1 (real time)',
              ),
              h('dt', {}, 'Session replay'),
              h('dd', {}, health.replay ? 'Enabled' : 'Disabled (no R2 bucket)'),
              h('dt', {}, 'Signed in with'),
              h('dd', {}, sessionControl()),
            ),
          ],
          { icon: 'zap' },
        ),
      );
    }),
  ];
}

export function keyScreen(onDone: () => void): HTMLElement {
  const input = h('input', {
    type: 'password',
    required: true,
    autocomplete: 'off',
    placeholder: 'Paste your Dataflare API key',
    'aria-label': 'API key',
  });
  const error = h('div', {});
  const form = h(
    'form',
    { class: 'stack' },
    input,
    error,
    h('button', { type: 'submit', class: 'primary' }, 'Open dashboard', icon('arrowRight', 15)),
  );
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    prefs.key = input.value.trim();
    try {
      await api.get('/api');
      onDone();
    } catch (err) {
      prefs.key = null;
      mount(error, errorState(err));
    }
  });
  return h(
    'main',
    { class: 'key-screen' },
    h(
      'div',
      { class: 'key-card' },
      h(
        'div',
        { class: 'key-brand' },
        h('span', { class: 'mark large', 'aria-hidden': 'true' }),
        h('span', {}, 'Dataflare'),
      ),
      h('h1', {}, 'Open your dashboard'),
      h(
        'p',
        { class: 'muted' },
        'Paste the API key that ',
        h('code', {}, 'dataflare init'),
        ' created. Print it again any time:',
      ),
      codeBlock('npx @gmacko/dataflare-cli key'),
      form,
      h(
        'p',
        { class: 'muted small key-note' },
        icon('key', 13),
        ' The key stays in this browser. Share the read-only key to let people look without changing flags.',
      ),
    ),
    h(
      'p',
      { class: 'key-foot muted small' },
      'Analytics that lives in your own Cloudflare account.',
    ),
  );
}

export function accessSignIn(): HTMLElement {
  return h(
    'main',
    { class: 'key-screen' },
    h(
      'div',
      { class: 'key-card' },
      h('h1', {}, 'Sign in to continue'),
      h('p', { class: 'muted' }, 'Your Cloudflare Access session has ended.'),
      h(
        'button',
        { type: 'button', class: 'primary', onclick: () => location.reload() },
        'Sign in with Cloudflare Access',
      ),
    ),
  );
}
