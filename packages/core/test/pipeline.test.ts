/**
 * The data pipeline's pure parts: transformations, import presets, destination
 * templates, secret encryption, AWS SigV4 (against AWS's own S3 examples),
 * Google service-account JWTs and export formats.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { signSigV4 } from '../src/aws-sigv4.ts';
import { decryptJson, encryptJson, secretKey, sha256Normalised } from '../src/crypto.ts';
import { normalisePhone } from '../src/destinations/ads.ts';
import { type DeliveryEvent, TEMPLATES } from '../src/destinations/index.ts';
import { interpolate } from '../src/destinations/types.ts';
import type { StoredEvent } from '../src/events.ts';
import { formatRows, gunzip, gzip } from '../src/exports.ts';
import { serviceAccountAssertion } from '../src/google-auth.ts';
import { csvRecord, mapRecord, parseCsvLine, toMillis } from '../src/import-presets.ts';
import { applyTransformations, transformationSchema } from '../src/transformations.ts';

function row(props: object, extra: Partial<StoredEvent> = {}): StoredEvent {
  return {
    id: 'e1',
    project: 'p',
    event: 'signup',
    ts_ms: 1_700_000_000_000,
    distinct_id: 'd',
    user_id: null,
    person_id: 'd',
    session_id: 's',
    url: 'https://acme.com/users/ann@example.com',
    host: 'acme.com',
    path: '/',
    referrer: '',
    referrer_host: '',
    title: 'Hi',
    utm_source: '',
    utm_medium: '',
    utm_campaign: '',
    utm_term: '',
    utm_content: '',
    country: 'GB',
    region: '',
    city: '',
    device: 'desktop',
    browser: 'Chrome',
    os: 'macOS',
    flags: '{}',
    props: JSON.stringify(props),
    person_props: JSON.stringify({ email: 'ann@example.com', plan: 'pro' }),
    lib: '',
    received_ms: 1_700_000_000_000,
    ...extra,
  };
}

const rule = (r: Record<string, unknown>) => transformationSchema.parse(r);

/** PEM armour for a key generated in the test (the label is split so secret scanners don't flag the source). */
const PEM_LABEL = ['PRIVATE', 'KEY'].join(' ');
const pkcs8Pem = (der: Uint8Array) =>
  `-----BEGIN ${PEM_LABEL}-----\n${Buffer.from(der).toString('base64')}\n-----END ${PEM_LABEL}-----\n`;

describe('transformations', () => {
  it('drops events, drops/renames/sets/hashes properties and redacts', async () => {
    const rows = [
      row({
        plan: 'pro',
        password: 'x',
        card: '4111 1111 1111 1111',
        note: 'call +44 20 7946 0958',
      }),
      row({}, { id: 'e2', event: 'debug_log' }),
    ];
    const { rows: out, counts } = await applyTransformations(
      rows,
      [
        rule({ kind: 'drop_event', events: ['debug_log'] }),
        rule({ kind: 'drop_properties', properties: ['password', '/^card$/'] }),
        rule({ kind: 'rename_property', from: 'plan', to: 'tier' }),
        rule({ kind: 'set_property', property: 'source', value: 'web' }),
        rule({ kind: 'hash_properties', properties: ['person.email'] }),
        rule({ kind: 'redact', patterns: ['email', 'phone'] }),
      ],
      'salt',
    );
    assert.equal(out.length, 1);
    const props = JSON.parse(out[0]!.props);
    assert.deepEqual(Object.keys(props).sort(), ['note', 'source', 'tier']);
    assert.equal(props.tier, 'pro');
    assert.equal(props.note, 'call [redacted]');
    const person = JSON.parse(out[0]!.person_props);
    assert.match(person.email, /^[0-9a-f]{64}$/);
    assert.equal(out[0]!.url, 'https://acme.com/users/[redacted]');
    assert.deepEqual(counts, [1, 2, 1, 1, 1, 1]);
  });

  it('only applies to matching events', async () => {
    const { rows: out } = await applyTransformations(
      [row({ plan: 'pro' }), row({ plan: 'free' }, { id: 'e2' })],
      [rule({ kind: 'drop_event', filters: [{ property: 'plan', value: 'free' }] })],
      's',
    );
    assert.deepEqual(
      out.map((r) => r.id),
      ['e1'],
    );
  });
});

describe('import presets', () => {
  it('reads timestamps in every format', () => {
    assert.equal(toMillis('2024-01-02T03:04:05Z'), Date.UTC(2024, 0, 2, 3, 4, 5));
    assert.equal(toMillis('2024-01-02 03:04:05.500'), Date.UTC(2024, 0, 2, 3, 4, 5, 500));
    assert.equal(toMillis(1_704_164_645), 1_704_164_645_000);
    assert.equal(toMillis('1704164645000000'), 1_704_164_645_000);
  });

  it('maps PostHog, Mixpanel, Amplitude, Segment and GA4 exports', async () => {
    const ph = await mapRecord('posthog', {
      uuid: '0190-uuid',
      event: '$pageview',
      timestamp: '2024-01-02T03:04:05Z',
      distinct_id: 'user-1',
      properties: {
        $current_url: 'https://acme.com/',
        $browser: 'Firefox',
        $geoip_country_code: 'FR',
        $is_identified: true,
        plan: 'pro',
      },
    });
    assert.deepEqual(
      [ph!.id, ph!.event, ph!.url, ph!.user_id, ph!.props, ph!.context?.country],
      ['0190-uuid', '$pageview', 'https://acme.com/', 'user-1', { plan: 'pro' }, 'FR'],
    );
    const mp = await mapRecord('mixpanel', {
      event: '$mp_web_page_view',
      properties: {
        time: 1_704_164_645,
        distinct_id: 'u',
        $insert_id: 'ins',
        $current_url: 'https://a.com',
        mp_country_code: 'DE',
        size: 3,
      },
    });
    assert.deepEqual(
      [mp!.id, mp!.event, mp!.ts, mp!.props, mp!.context?.country],
      ['ins', '$pageview', 1_704_164_645_000, { size: 3 }, 'DE'],
    );
    const amp = await mapRecord('amplitude', {
      event_type: '[Amplitude] Page Viewed',
      event_time: '2024-01-02 03:04:05.000',
      device_id: 'dev',
      user_id: 'u',
      uuid: 'amp-1',
      event_properties: { '[Amplitude] Page URL': 'https://a.com/x', tab: 'b' },
      country: 'United Kingdom',
    });
    assert.deepEqual(
      [amp!.event, amp!.url, amp!.props, amp!.user_id],
      ['$pageview', 'https://a.com/x', { tab: 'b' }, 'u'],
    );
    const seg = await mapRecord('segment', {
      type: 'identify',
      userId: 'u',
      anonymousId: 'anon',
      traits: { plan: 'pro' },
      timestamp: '2024-01-02T03:04:05Z',
      messageId: 'm1',
    });
    assert.deepEqual(
      [seg!.event, seg!.distinct_id, seg!.props],
      ['$identify', 'anon', { $set: { plan: 'pro' } }],
    );
    const ga = await mapRecord('ga4', {
      event_name: 'page_view',
      event_timestamp: '1704164645000000',
      user_pseudo_id: 'p1',
      event_params: [
        { key: 'page_location', value: { string_value: 'https://a.com/y' } },
        { key: 'ga_session_id', value: { int_value: 42 } },
        { key: 'campaign', value: { string_value: 'spring' } },
      ],
      geo: { country: 'Spain' },
      device: { category: 'mobile', operating_system: 'iOS', web_info: { browser: 'Safari' } },
    });
    assert.deepEqual(
      [ga!.event, ga!.url, ga!.session_id, ga!.props, ga!.context?.device],
      ['$pageview', 'https://a.com/y', 'ga_p1_42', { campaign: 'spring' }, 'mobile'],
    );
  });

  it('gives records without ids a stable one, and skips what it cannot read', async () => {
    const r = { event: 'x', ts: 1_700_000_000_000, distinct_id: 'd' };
    assert.equal((await mapRecord('raw', r))!.id, (await mapRecord('raw', { ...r }))!.id);
    assert.equal(await mapRecord('raw', { event: 'x' }), null);
  });

  it('parses CSV rows', () => {
    const header = parseCsvLine('event,timestamp,distinct_id,plan,properties');
    const cells = parseCsvLine('signup,2024-01-02T00:00:00Z,u1,pro,"{""seats"":3}"');
    const rec = csvRecord(header, cells);
    assert.deepEqual(rec.props, { seats: 3, plan: 'pro' });
    assert.equal(rec.event, 'signup');
  });
});

function delivery(extra: Partial<DeliveryEvent> = {}): DeliveryEvent {
  return {
    id: 'evt-1',
    event: 'order_paid',
    ts_ms: 1_700_000_000_000,
    distinct_id: 'dev',
    user_id: 'user-1',
    person_id: 'user-1',
    session_id: 's',
    url: 'https://acme.com/checkout',
    host: 'acme.com',
    path: '/checkout',
    referrer: '',
    title: '',
    utm_source: '',
    utm_medium: '',
    utm_campaign: '',
    utm_term: '',
    utm_content: '',
    country: 'GB',
    region: '',
    city: '',
    device: 'desktop',
    browser: 'Chrome',
    os: 'macOS',
    props: { amount: 49, currency: 'gbp', plan: 'pro' },
    person: { email: ' Ann@Example.com ', phone: '+44 (0)20 7946 0958', name: 'Ann' },
    flags: {},
    ...extra,
  };
}

describe('destination templates', () => {
  it('sends people, companies and events to the CRMs, and skips what they cannot take', async () => {
    const identify = delivery({ event: '$identify', props: { $set: { plan: 'team' } } });
    const company = delivery({
      event: '$groupidentify',
      props: {
        $group_type: 'company',
        $group_key: 'acme',
        $group_set: { domain: 'acme.com', seats: 12 },
      },
    });
    const pageview = delivery({ event: '$pageview' });

    // Customer.io: people, companies as objects, events; EU host; nothing for built-in events.
    const [cioPerson] = (await TEMPLATES.customerio!.render(identify, {
      siteId: 's',
      apiKey: 'k',
      eu: true,
    }))!;
    assert.equal(new URL(cioPerson!.url).hostname, 'track-eu.customer.io');
    const person = JSON.parse(cioPerson!.body!);
    assert.deepEqual(
      [person.type, person.action, person.attributes.plan],
      ['person', 'identify', 'team'],
    );
    const [cioCompany] = (await TEMPLATES.customerio!.render(company, {
      siteId: 's',
      apiKey: 'k',
    }))!;
    assert.deepEqual(JSON.parse(cioCompany!.body!).identifiers, {
      object_type_id: '1',
      object_id: 'acme',
    });
    const [cioEvent] = (await TEMPLATES.customerio!.render(delivery(), {
      siteId: 's',
      apiKey: 'k',
    }))!;
    assert.deepEqual(JSON.parse(cioEvent!.body!).attributes, {
      amount: 49,
      currency: 'gbp',
      plan: 'pro',
    });
    assert.equal(await TEMPLATES.customerio!.render(pageview, { siteId: 's', apiKey: 'k' }), null);

    // Loops: contact updates without the email in the properties, events by email and user id.
    const [loopsContact] = (await TEMPLATES.loops!.render(identify, { apiKey: 'k' }))!;
    assert.equal(loopsContact!.method, 'PUT');
    const contact = JSON.parse(loopsContact!.body!);
    assert.equal(contact.email, ' Ann@Example.com ');
    assert.equal(contact.plan, 'team');
    const [loopsEvent] = (await TEMPLATES.loops!.render(delivery(), { apiKey: 'k' }))!;
    assert.deepEqual(
      [JSON.parse(loopsEvent!.body!).eventName, JSON.parse(loopsEvent!.body!).userId],
      ['order_paid', 'user-1'],
    );
    assert.equal(await TEMPLATES.loops!.render(pageview, { apiKey: 'k' }), null);
    assert.equal(
      await TEMPLATES.loops!.render(delivery({ user_id: null, person: {} }), { apiKey: 'k' }),
      null,
      'no email and no user id: nothing to update',
    );

    // HubSpot: contacts by email (properties made HubSpot-safe), companies only with a domain.
    const [hsContact] = (await TEMPLATES.hubspot!.render(identify, { accessToken: 't' }))!;
    const input = JSON.parse(hsContact!.body!).inputs[0];
    assert.deepEqual([input.idProperty, input.properties.plan], ['email', 'team']);
    assert.equal(
      await TEMPLATES.hubspot!.render(
        delivery({ event: '$groupidentify', props: { $group_type: 'company', $group_key: 'x' } }),
        { accessToken: 't' },
      ),
      null,
    );
    assert.equal(await TEMPLATES.hubspot!.render(delivery(), { accessToken: 't' }), null);
    assert.equal(
      await TEMPLATES.hubspot!.render(delivery({ event: '$identify', person: {} }), {
        accessToken: 't',
      }),
      null,
    );
  });

  it('fills placeholders', () => {
    assert.equal(
      interpolate('{event} by {person.name} for {props.amount}', delivery()),
      'order_paid by Ann for 49',
    );
  });

  it('builds Slack, webhook and Teams requests', async () => {
    const [slack] = (await TEMPLATES.slack!.render(delivery(), {
      url: 'https://hooks.slack.com/x',
      message: '{event} by {who}',
    }))!;
    assert.deepEqual(JSON.parse(slack!.body!), { text: 'order_paid by  Ann@Example.com ' });
    const [hook] = (await TEMPLATES.webhook!.render(delivery(), {
      url: 'https://example.com/hook',
      body: '{"name":"{event}","email":"{person.email}"}',
      headers: { 'X-Key': 'k' },
    }))!;
    assert.deepEqual(JSON.parse(hook!.body!), { name: 'order_paid', email: ' Ann@Example.com ' });
    assert.equal(hook!.headers['X-Key'], 'k');
    const [teams] = (await TEMPLATES.teams!.render(delivery(), { url: 'https://x' }))!;
    assert.equal(JSON.parse(teams!.body!).attachments[0].content.type, 'AdaptiveCard');
  });

  it('hashes identifiers for the Meta Conversions API and maps events', async () => {
    const config = {
      pixelId: '123',
      accessToken: 'tok',
      eventMap: { order_paid: 'Purchase' },
      valueProperty: 'props.amount',
    };
    const [req] = (await TEMPLATES['meta-capi']!.render(delivery(), config))!;
    assert.match(req!.url, /graph\.facebook\.com\/v21\.0\/123\/events\?access_token=tok/);
    const data = JSON.parse(req!.body!).data[0];
    assert.equal(data.event_name, 'Purchase');
    assert.equal(data.event_id, 'evt-1');
    assert.equal(data.event_time, 1_700_000_000);
    assert.deepEqual(data.user_data.em, [await sha256Normalised('ann@example.com')]);
    assert.deepEqual(data.user_data.ph, [await sha256Normalised('442079460958')]);
    assert.deepEqual(data.custom_data, { value: 49, currency: 'GBP' });
    // Unmapped events are skipped.
    assert.equal(await TEMPLATES['meta-capi']!.render(delivery({ event: 'other' }), config), null);
  });

  it('normalises phone numbers the way each ad platform matches them', () => {
    assert.equal(normalisePhone('+44 (0)20 7946 0958', 'digits'), '442079460958');
    assert.equal(normalisePhone('0044 20 7946 0958', 'e164'), '+442079460958');
    assert.equal(normalisePhone('+1 (650) 123-4567', 'e164'), '+16501234567');
    assert.equal(normalisePhone('07946 095800', 'digits', '44'), '447946095800');
    assert.equal(normalisePhone('n/a', 'digits'), null);
  });

  it('builds GA4, TikTok, CRM and analytics requests', async () => {
    const [ga] = (await TEMPLATES.ga4!.render(delivery(), {
      measurementId: 'G-1',
      apiSecret: 's',
      valueProperty: 'props.amount',
    }))!;
    const gaBody = JSON.parse(ga!.body!);
    assert.equal(gaBody.client_id, 'dev');
    assert.equal(gaBody.events[0].name, 'order_paid');
    assert.equal(gaBody.events[0].params.value, 49);
    const [tt] = (await TEMPLATES.tiktok!.render(delivery(), {
      pixelCode: 'C1',
      accessToken: 't',
      eventMap: { order_paid: 'CompletePayment' },
    }))!;
    assert.equal(tt!.headers['Access-Token'], 't');
    assert.equal(JSON.parse(tt!.body!).data[0].user.phone, await sha256Normalised('+442079460958'));
    const [cio] = (await TEMPLATES.customerio!.render(delivery(), { siteId: 's', apiKey: 'k' }))!;
    assert.equal(JSON.parse(cio!.body!).action, 'event');
    const group = delivery({
      event: '$groupidentify',
      props: { $group_type: 'company', $group_key: 'acme', $group_set: { domain: 'acme.com' } },
    });
    const [hs] = (await TEMPLATES.hubspot!.render(group, { accessToken: 't' }))!;
    assert.match(hs!.url, /companies\/batch\/upsert/);
    const [mp] = (await TEMPLATES.mixpanel!.render(delivery(), {
      projectToken: 'p',
      apiSecret: 's',
      eu: true,
    }))!;
    assert.equal(new URL(mp!.url).hostname, 'api-eu.mixpanel.com');
    assert.equal(new URL(mp!.url).pathname, '/import');
    const [amp] = (await TEMPLATES.amplitude!.render(delivery(), { apiKey: 'k' }))!;
    assert.equal(JSON.parse(amp!.body!).events[0].insert_id, 'evt-1');
    const [ph] = (await TEMPLATES.posthog!.render(delivery(), {
      apiKey: 'phc',
      host: 'https://eu.i.posthog.com',
    }))!;
    assert.equal(ph!.url, 'https://eu.i.posthog.com/batch/');
  });
});

describe('security helpers', () => {
  it('encrypts and decrypts secrets, and rejects the wrong key', async () => {
    const key = await secretKey('salt-1');
    const text = await encryptJson(key, { token: 'abc' });
    assert.deepEqual(await decryptJson(key, text), { token: 'abc' });
    await assert.rejects(decryptJson(await secretKey('salt-2'), text));
  });

  it('signs S3 requests like AWS’s documented examples', async () => {
    // https://docs.aws.amazon.com/AmazonS3/latest/API/sig-v4-header-based-auth.html — GET Object.
    const get = await signSigV4({
      method: 'GET',
      url: 'https://examplebucket.s3.amazonaws.com/test.txt',
      region: 'us-east-1',
      accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
      secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
      headers: { range: 'bytes=0-9' },
      now: new Date('2013-05-24T00:00:00Z'),
    });
    assert.match(
      get.authorization!,
      /Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41$/,
    );
    // PUT Object.
    const put = await signSigV4({
      method: 'PUT',
      url: 'https://examplebucket.s3.amazonaws.com/test$file.text',
      region: 'us-east-1',
      accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
      secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
      headers: {
        date: 'Fri, 24 May 2013 00:00:00 GMT',
        'x-amz-storage-class': 'REDUCED_REDUNDANCY',
      },
      body: new TextEncoder().encode('Welcome to Amazon S3.'),
      now: new Date('2013-05-24T00:00:00Z'),
    });
    assert.match(
      put.authorization!,
      /Signature=98ad721746da40c64f1a55b78f14c238d841ea1380cd77a1b5971af0ece108bd$/,
    );
  });

  it('signs a Google service-account assertion that verifies', async () => {
    const pair = (await crypto.subtle.generateKey(
      {
        name: 'RSASSA-PKCS1-v1_5',
        modulusLength: 2048,
        publicExponent: new Uint8Array([1, 0, 1]),
        hash: 'SHA-256',
      },
      true,
      ['sign', 'verify'],
    )) as CryptoKeyPair;
    const der = new Uint8Array(await crypto.subtle.exportKey('pkcs8', pair.privateKey));
    const pem = pkcs8Pem(der);
    const jwt = await serviceAccountAssertion(
      { client_email: 'sa@p.iam.gserviceaccount.com', private_key: pem },
      'scope',
      1_700_000_000_000,
    );
    const [h, c, sig] = jwt.split('.');
    const claims = JSON.parse(Buffer.from(c!, 'base64url').toString());
    assert.equal(claims.iss, 'sa@p.iam.gserviceaccount.com');
    assert.equal(claims.exp - claims.iat, 3600);
    const ok = await crypto.subtle.verify(
      'RSASSA-PKCS1-v1_5',
      pair.publicKey,
      Buffer.from(sig!, 'base64url'),
      new TextEncoder().encode(`${h}.${c}`),
    );
    assert.equal(ok, true);
  });

  it('formats and gzips export files', async () => {
    const rows = [row({ plan: 'pro' }) as unknown as Record<string, unknown>];
    const jsonl = formatRows(rows, 'jsonl');
    assert.equal(JSON.parse(jsonl.trim()).props.plan, 'pro');
    const csv = formatRows(rows, 'csv');
    assert.match(csv.split('\n')[0]!, /^id,project,event,ts_ms/);
    assert.equal(await gunzip(await gzip(jsonl)), jsonl);
  });
});
