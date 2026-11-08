import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  isPseudonym,
  looksLikePii,
  sanitizeMinorsEvent,
  sanitizePath,
  sanitizeUrl,
  scrubReplayEvents,
  studentPolicySchema,
} from '../src/student-policy.ts';

const policy = studentPolicySchema.parse({
  audience: 'minors',
  event_properties: ['lesson_kind', 'score'],
  person_properties: ['grade_band'],
});
const PSEUDONYM = 'a'.repeat(64);

describe('student policy', () => {
  it('accepts only pseudonyms as user ids', () => {
    assert.equal(isPseudonym(PSEUDONYM, policy), true);
    assert.equal(isPseudonym('x'.repeat(43), policy), true);
    assert.equal(isPseudonym('jane.doe@school.org', policy), false);
    assert.equal(isPseudonym('Jane Doe', policy), false);
    assert.equal(isPseudonym('12345', policy), false);
    const loose = studentPolicySchema.parse({ audience: 'minors', pseudonym_pattern: '^.+$' });
    // "@" and whitespace are refused whatever the configured pattern allows.
    assert.equal(isPseudonym('kid@example.com', loose), false);
    assert.equal(isPseudonym('first last', loose), false);
  });

  it('refuses unanchored or invalid pseudonym patterns', () => {
    assert.equal(
      studentPolicySchema.safeParse({ audience: 'minors', pseudonym_pattern: 'a+' }).success,
      false,
    );
    assert.equal(
      studentPolicySchema.safeParse({ audience: 'minors', pseudonym_pattern: '^(' }).success,
      false,
    );
  });

  it('recognises contact details and ids', () => {
    for (const v of ['kid@example.com', '555-123-4567', '+1 (555) 123 4567', '123-45-6789'])
      assert.equal(looksLikePii(v), true, v);
    for (const v of ['quiz', 'grade 5', '2026', 'level-3']) assert.equal(looksLikePii(v), false, v);
  });

  it('reduces URLs to paths without ids', () => {
    assert.equal(
      sanitizeUrl('https://lms.test/courses/48213/students/jane%40x.org/grades?token=abc#top'),
      'https://lms.test/courses/:id/students/:redacted/grades',
    );
    assert.equal(sanitizePath('/s/3f2504e0-4f89-41d3-9a0c-0305e82c3301/work'), '/s/:id/work');
    assert.equal(sanitizePath('/lesson/fractions'), '/lesson/fractions');
    assert.equal(sanitizeUrl('javascript:alert(1)'), '');
  });

  it('strips everything an SDK might send that the policy does not allow', () => {
    const { event, removed } = sanitizeMinorsEvent(
      {
        id: 'e1',
        event: 'lesson_completed',
        ts: 1,
        distinct_id: 'device-from-localstorage',
        session_id: 'sess',
        user_id: 'jane.doe@school.org',
        url: 'https://lms.test/class/991122?student=jane',
        referrer: 'https://mail.test/inbox/thread/42?q=jane',
        title: 'Jane Doe – Report card',
        props: {
          lesson_kind: 'video',
          score: 9,
          student_name: 'Jane Doe',
          note: 'call 555-123-4567',
        },
      },
      policy,
    );
    assert.ok(event);
    assert.equal(event.distinct_id, null);
    assert.equal(event.session_id, null);
    assert.equal(event.user_id, null);
    assert.equal(event.url, 'https://lms.test/class/:id');
    assert.equal(event.referrer, 'https://mail.test');
    assert.equal(event.title, '');
    assert.deepEqual(event.props, { lesson_kind: 'video', score: 9 });
    assert.ok(removed.includes('user_id'));
    assert.ok(removed.includes('props.student_name'));
  });

  it('drops allowed keys whose values look like PII', () => {
    const { event } = sanitizeMinorsEvent(
      { id: 'e', event: 'x', ts: 1, props: { lesson_kind: 'kid@example.com', score: Number.NaN } },
      policy,
    );
    assert.deepEqual(event?.props, {});
  });

  it('keeps only safe parts of system events and person properties', () => {
    const click = sanitizeMinorsEvent(
      {
        id: 'c',
        event: '$click',
        ts: 1,
        props: {
          tag: 'a',
          text: 'Jane Doe',
          id: 'student-77',
          href: 'https://lms.test/u/123456?x=1',
        },
      },
      policy,
    ).event;
    assert.deepEqual(click?.props, { tag: 'a', href: 'https://lms.test/u/:id' });
    const error = sanitizeMinorsEvent(
      {
        id: 'x',
        event: '$exception',
        ts: 1,
        props: { type: 'TypeError', message: 'jane is undefined' },
      },
      policy,
    ).event;
    assert.deepEqual(error?.props, { type: 'TypeError' });

    const identify = sanitizeMinorsEvent(
      {
        id: 'i',
        event: '$identify',
        ts: 1,
        user_id: PSEUDONYM,
        props: { $set: { grade_band: '3-5', email: 'kid@example.com', name: 'Jane' } },
      },
      policy,
    ).event;
    assert.equal(identify?.user_id, PSEUDONYM);
    assert.deepEqual(identify?.props, { $set: { grade_band: '3-5' } });
  });

  it('drops identify without a pseudonym and unknown system events', () => {
    assert.equal(
      sanitizeMinorsEvent(
        { id: 'i', event: '$identify', ts: 1, user_id: 'kid@example.com' },
        policy,
      ).event,
      null,
    );
    assert.equal(
      sanitizeMinorsEvent({ id: 'i', event: '$autocapture', ts: 1 }, policy).event,
      null,
    );
  });
});

describe('replay scrubbing', () => {
  it('masks text, inputs and free-text attributes and drops console and network', () => {
    const events = scrubReplayEvents([
      {
        type: 4,
        timestamp: 1,
        data: { href: 'https://lms.test/u/123456?x=1', width: 1, height: 1 },
      },
      {
        type: 2,
        timestamp: 2,
        data: {
          node: {
            type: 0,
            id: 1,
            childNodes: [
              {
                type: 2,
                id: 2,
                tagName: 'style',
                attributes: { _cssText: 'body{color:red}' },
                childNodes: [{ type: 3, id: 3, textContent: 'body{color:red}', isStyle: true }],
              },
              {
                type: 2,
                id: 4,
                tagName: 'div',
                attributes: {
                  class: 'card',
                  title: 'Jane Doe',
                  'data-student': 'Jane',
                  'aria-label': 'Jane',
                },
                childNodes: [{ type: 3, id: 5, textContent: 'Jane Doe, grade 4' }],
              },
              {
                type: 2,
                id: 6,
                tagName: 'img',
                attributes: { src: 'https://cdn.test/photos/jane.jpg', alt: 'Jane' },
              },
              {
                type: 2,
                id: 7,
                tagName: 'input',
                attributes: { type: 'text', value: 'Jane', placeholder: 'Name' },
              },
            ],
          },
        },
      },
      {
        type: 3,
        timestamp: 3,
        data: {
          source: 0,
          texts: [{ id: 5, value: 'Sam Lee' }],
          attributes: [{ id: 4, attributes: { title: 'Sam', class: 'card on' } }],
          adds: [{ parentId: 1, node: { type: 3, id: 9, textContent: 'Hello Sam' } }],
          removes: [],
        },
      },
      { type: 3, timestamp: 4, data: { source: 5, id: 7, text: 'Sam', isChecked: false } },
      { type: 5, timestamp: 5, data: { tag: 'glass:console', payload: { message: 'user sam' } } },
      {
        type: 5,
        timestamp: 6,
        data: { tag: 'glass:network', payload: { url: '/api/students/1' } },
      },
      {
        type: 5,
        timestamp: 7,
        data: { tag: 'glass:url', payload: { href: 'https://lms.test/c/99999?n=1' } },
      },
      { type: 6, timestamp: 8, data: { plugin: 'x', payload: { secret: 'Jane' } } },
      { type: 3, timestamp: 9, data: { source: 1, positions: [{ x: 1, y: 2 }] } },
    ]);
    const text = JSON.stringify(events);
    for (const secret of [
      'Jane',
      'Sam',
      'jane.jpg',
      '123456',
      '99999',
      'placeholder',
      'console',
      'network',
    ])
      assert.ok(!text.includes(secret), `${secret} leaked: ${text}`);
    assert.ok(text.includes('body{color:red}'), 'styles survive so the page still renders');
    assert.ok(text.includes('"class":"card on"'));
    // Kept: meta, snapshot, mutation, input, navigation, mouse move.
    assert.equal(events.length, 6);
    const full = events[1]!.data.node.childNodes[1];
    assert.equal(full.childNodes[0].textContent, '**** **** ***** *');
    assert.deepEqual(full.attributes, { class: 'card' });
  });
});
