/**
 * Other analytics tools: send the same events to Mixpanel, Amplitude or PostHog
 * (to migrate, to compare, or to keep a second copy).
 */

import { trimTrailingSlashes } from '../url.ts';
import { type DeliveryEvent, type DestinationTemplate, JSON_HEADERS, json, str } from './types.ts';

const setOf = (event: DeliveryEvent) =>
  (event.props.$set as Record<string, unknown> | undefined) ?? {};

export const MIXPANEL: DestinationTemplate = {
  id: 'mixpanel',
  name: 'Mixpanel',
  description: 'Import events (and profile updates on identify) into a Mixpanel project.',
  category: 'analytics',
  inputs: [
    { key: 'projectToken', label: 'Project token', type: 'string', required: true },
    { key: 'apiSecret', label: 'Project API secret (for /import)', type: 'secret', required: true },
    { key: 'eu', label: 'EU data residency', type: 'boolean' },
  ],
  async render(event, config) {
    const host = config.eu ? 'api-eu.mixpanel.com' : 'api.mixpanel.com';
    const distinctId = event.user_id ?? event.distinct_id;
    const headers = {
      ...JSON_HEADERS,
      Authorization: `Basic ${btoa(`${str(config.apiSecret)}:`)}`,
    };
    if (event.event === '$identify' || event.event === '$set') {
      return [
        {
          url: `https://${host}/engage#profile-set`,
          method: 'POST',
          headers: JSON_HEADERS,
          body: json([
            { $token: str(config.projectToken), $distinct_id: distinctId, $set: setOf(event) },
          ]),
        },
      ];
    }
    const name = event.event === '$pageview' ? '$mp_web_page_view' : event.event;
    return [
      {
        url: `https://${host}/import?strict=1`,
        method: 'POST',
        headers,
        body: json([
          {
            event: name,
            properties: {
              time: event.ts_ms,
              distinct_id: distinctId,
              $insert_id: event.id,
              $current_url: event.url,
              $browser: event.browser,
              $os: event.os,
              mp_country_code: event.country,
              utm_source: event.utm_source || undefined,
              utm_medium: event.utm_medium || undefined,
              utm_campaign: event.utm_campaign || undefined,
              ...event.props,
            },
          },
        ]),
      },
    ];
  },
};

export const AMPLITUDE: DestinationTemplate = {
  id: 'amplitude',
  name: 'Amplitude',
  description: 'Send events to an Amplitude project with the HTTP V2 API.',
  category: 'analytics',
  inputs: [
    { key: 'apiKey', label: 'API key', type: 'secret', required: true },
    { key: 'eu', label: 'EU data center', type: 'boolean' },
  ],
  async render(event, config) {
    const host = config.eu ? 'api.eu.amplitude.com' : 'api2.amplitude.com';
    const identify = event.event === '$identify' || event.event === '$set';
    return [
      {
        url: `https://${host}/2/httpapi`,
        method: 'POST',
        headers: JSON_HEADERS,
        body: json({
          api_key: str(config.apiKey),
          events: [
            {
              ...(event.user_id ? { user_id: event.user_id } : {}),
              device_id: event.distinct_id,
              event_type: identify
                ? '$identify'
                : event.event === '$pageview'
                  ? '[Amplitude] Page Viewed'
                  : event.event,
              time: event.ts_ms,
              insert_id: event.id,
              ...(identify
                ? { user_properties: { $set: setOf(event) } }
                : { event_properties: { ...event.props, page_url: event.url } }),
              country: event.country,
              os_name: event.os,
              platform: 'Web',
            },
          ],
        }),
      },
    ];
  },
};

export const POSTHOG: DestinationTemplate = {
  id: 'posthog',
  name: 'PostHog',
  description: 'Send events to a PostHog project (US, EU or self-hosted).',
  category: 'analytics',
  inputs: [
    { key: 'apiKey', label: 'Project API key', type: 'string', required: true },
    {
      key: 'host',
      label: 'Host',
      type: 'string',
      default: 'https://us.i.posthog.com',
      description: 'e.g. https://eu.i.posthog.com',
    },
  ],
  async render(event, config) {
    const host = trimTrailingSlashes(str(config.host) || 'https://us.i.posthog.com');
    const groups = event.props.$groups as Record<string, string> | undefined;
    return [
      {
        url: `${host}/batch/`,
        method: 'POST',
        headers: JSON_HEADERS,
        body: json({
          api_key: str(config.apiKey),
          batch: [
            {
              event: event.event,
              distinct_id: event.user_id ?? event.distinct_id,
              uuid: /^[0-9a-f-]{36}$/i.test(event.id) ? event.id : undefined,
              timestamp: new Date(event.ts_ms).toISOString(),
              properties: {
                ...event.props,
                $current_url: event.url,
                $host: event.host,
                $pathname: event.path,
                $referrer: event.referrer,
                $browser: event.browser,
                $os: event.os,
                $geoip_country_code: event.country,
                ...(groups ? { $groups: groups } : {}),
              },
            },
          ],
        }),
      },
    ];
  },
};
