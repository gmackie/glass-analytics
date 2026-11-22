# Server SDK: `dataflare-node`

For Node 18+, Bun, Deno and Cloudflare Workers. No dependencies: it only needs `fetch`.

```js
import { Dataflare } from 'dataflare-node';

const glass = new Dataflare({
  host: 'https://glass.acme.workers.dev',
  project: 'my-app',
  serverKey: process.env.GLASS_SERVER_KEY, // npx dataflare-cli key --server
});
```

## Events

```js
glass.capture({ distinctId: user.id, event: 'invoice_paid', properties: { amount: 49 } });
glass.identify({ distinctId: user.id, properties: { plan: 'pro' } });
glass.setPersonProperties(user.id, { plan: 'team' });
glass.groupIdentify({ groupType: 'company', groupKey: org.id, properties: { name: org.name } });
glass.capture({ distinctId: user.id, event: 'report_run', groups: { company: org.id } });
```

Events are batched (`flushAt`, default 20; `flushIntervalMs`, default 10 s). Call `await glass.shutdown()` before the process exits, or `await glass.flush()` at the end of a serverless request. With a server key, events can carry a `timestamp` older than seven days and trusted `context` (country, browser), and `glass.import(events)` loads history.

## Exceptions

```js
try {
  await chargeCard(order);
} catch (err) {
  glass.captureException(err, { distinctId: user.id, properties: { order: order.id } });
}
```

They're grouped into issues like browser errors; set `release` in the options to map stacks with uploaded source maps. See [errors](errors.md).

## Feature flags

```js
const variant = await glass.getFeatureFlag('new-checkout', user.id, {
  personProperties: { plan: user.plan },
  groups: { company: org.id },
});
if (await glass.isFeatureEnabled('beta-editor', user.id)) {
  // …
}
const copy = await glass.getFeatureFlagPayload('pricing-copy', user.id);
const all = await glass.getAllFlags(user.id);
const boot = await glass.bootstrap(user.id); // pass to the browser SDK's init({ bootstrap })
```

With a server key, flags are evaluated in-process. The SDK fetches the definitions (`GET /api/flags/definitions`) and refreshes them every 30 seconds (`pollIntervalMs`). It uses the same evaluation code as the Worker, so the answers are identical. When a rule needs something the SDK can't know locally, it asks the Worker instead: a person property you didn't pass, or membership of a cohort that isn't a plain list. `onlyEvaluateLocally: true` returns `null` in that case instead. Without a server key, every check asks the Worker.

The first read of each flag per user records an `$exposure`, which experiments count. Turn that off with `sendExposures: false`.
