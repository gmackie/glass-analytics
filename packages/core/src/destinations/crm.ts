/**
 * CRMs and messaging: Customer.io, Loops and HubSpot. People are created or
 * updated on `$identify`/`$set`, groups (companies) on `$groupidentify`, and
 * other events are tracked where the tool supports it.
 */

import { type DeliveryEvent, type DestinationTemplate, JSON_HEADERS, json, str } from './types.ts';

const IDENTITY = new Set(['$identify', '$set']);
const setOf = (event: DeliveryEvent) =>
  ({
    ...event.person,
    ...((event.props.$set as Record<string, unknown> | undefined) ?? {}),
  }) as Record<string, unknown>;
const groupOf = (event: DeliveryEvent) =>
  event.event === '$groupidentify'
    ? {
        type: str(event.props.$group_type),
        key: str(event.props.$group_key),
        props: (event.props.$group_set as Record<string, unknown> | undefined) ?? {},
      }
    : null;
const plainProps = (event: DeliveryEvent) =>
  Object.fromEntries(Object.entries(event.props).filter(([k]) => !k.startsWith('$')));

export const CUSTOMERIO: DestinationTemplate = {
  id: 'customerio',
  name: 'Customer.io',
  description:
    'Identify people (and companies as objects) and track events in Customer.io for messaging.',
  category: 'crm',
  inputs: [
    { key: 'siteId', label: 'Site id', type: 'string', required: true },
    { key: 'apiKey', label: 'Tracking API key', type: 'secret', required: true },
    { key: 'eu', label: 'EU region', type: 'boolean' },
    { key: 'objectTypeId', label: 'Object type id for groups', type: 'string', default: '1' },
  ],
  async render(event, config) {
    const host = config.eu ? 'track-eu.customer.io' : 'track.customer.io';
    const auth = `Basic ${btoa(`${str(config.siteId)}:${str(config.apiKey)}`)}`;
    const id = event.user_id ?? event.person_id;
    const group = groupOf(event);
    const body = group
      ? {
          type: 'object',
          identifiers: { object_type_id: str(config.objectTypeId) || '1', object_id: group.key },
          action: 'identify',
          attributes: group.props,
        }
      : IDENTITY.has(event.event)
        ? { type: 'person', identifiers: { id }, action: 'identify', attributes: setOf(event) }
        : event.event.startsWith('$')
          ? null
          : {
              type: 'person',
              identifiers: { id },
              action: 'event',
              name: event.event,
              timestamp: Math.floor(event.ts_ms / 1000),
              attributes: plainProps(event),
            };
    if (!body) return null;
    return [
      {
        url: `https://${host}/api/v2/entity`,
        method: 'POST',
        headers: { ...JSON_HEADERS, Authorization: auth },
        body: json(body),
      },
    ];
  },
};

export const LOOPS: DestinationTemplate = {
  id: 'loops',
  name: 'Loops',
  description: 'Update Loops contacts on identify and send events that trigger loops.',
  category: 'crm',
  inputs: [
    { key: 'apiKey', label: 'API key', type: 'secret', required: true },
    { key: 'emailProperty', label: 'Email property', type: 'string', default: 'email' },
  ],
  async render(event, config) {
    const key = str(config.emailProperty) || 'email';
    const person = setOf(event);
    const email = str(person[key]);
    const userId = event.user_id ?? undefined;
    if (!email && !userId) return null;
    const headers = { ...JSON_HEADERS, Authorization: `Bearer ${str(config.apiKey)}` };
    if (IDENTITY.has(event.event)) {
      const { [key]: _drop, ...rest } = person;
      return [
        {
          url: 'https://app.loops.so/api/v1/contacts/update',
          method: 'PUT',
          headers,
          body: json({ ...(email ? { email } : {}), ...(userId ? { userId } : {}), ...rest }),
        },
      ];
    }
    if (event.event.startsWith('$')) return null;
    return [
      {
        url: 'https://app.loops.so/api/v1/events/send',
        method: 'POST',
        headers,
        body: json({
          ...(email ? { email } : {}),
          ...(userId ? { userId } : {}),
          eventName: event.event,
          eventProperties: plainProps(event),
        }),
      },
    ];
  },
};

export const HUBSPOT: DestinationTemplate = {
  id: 'hubspot',
  name: 'HubSpot',
  description: 'Upsert HubSpot contacts on identify and companies on group identify (by domain).',
  category: 'crm',
  inputs: [
    { key: 'accessToken', label: 'Private app access token', type: 'secret', required: true },
    { key: 'emailProperty', label: 'Email property', type: 'string', default: 'email' },
    {
      key: 'domainProperty',
      label: 'Company domain property',
      type: 'string',
      default: 'domain',
      description:
        'Group property holding the company’s domain (HubSpot’s unique key for companies).',
    },
  ],
  defaultEvents: ['$identify', '$set', '$groupidentify'],
  async render(event, config) {
    const headers = { ...JSON_HEADERS, Authorization: `Bearer ${str(config.accessToken)}` };
    const group = groupOf(event);
    if (group) {
      const domain = str(group.props[str(config.domainProperty) || 'domain']);
      if (!domain) return null;
      return [
        {
          url: 'https://api.hubapi.com/crm/v3/objects/companies/batch/upsert',
          method: 'POST',
          headers,
          body: json({
            inputs: [{ idProperty: 'domain', id: domain, properties: { ...group.props, domain } }],
          }),
        },
      ];
    }
    if (!IDENTITY.has(event.event)) return null;
    const person = setOf(event);
    const email = str(person[str(config.emailProperty) || 'email']);
    if (!email) return null;
    const properties = Object.fromEntries(
      Object.entries(person)
        .filter(([, v]) => v !== null && typeof v !== 'object')
        .map(([k, v]) => [k.toLowerCase().replace(/[^a-z0-9_]/g, '_'), String(v)]),
    );
    return [
      {
        url: 'https://api.hubapi.com/crm/v3/objects/contacts/batch/upsert',
        method: 'POST',
        headers,
        body: json({
          inputs: [{ idProperty: 'email', id: email, properties: { ...properties, email } }],
        }),
      },
    ];
  },
};
