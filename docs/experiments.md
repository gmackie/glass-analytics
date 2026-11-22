# Flags and experiments

## Flags

A flag has a rollout percentage, optional variants, and optional targeting rules:

```json
{
  "key": "new-checkout",
  "enabled": true,
  "rollout": 50,
  "variants": [{ "key": "control", "weight": 50 }, { "key": "test", "weight": 50 }],
  "rules": [
    {
      "conditions": [{ "property": "person.plan", "value": "enterprise" }],
      "rollout": 100,
      "variant": "test"
    }
  ]
}
```

- **Evaluation** happens in your Worker (`POST /f`), so rules that mention person properties never reach browsers. The SDK caches values on the device.
- **Assignment** is a hash of the flag key, an optional `salt` and the device's `distinct_id`, so it's stable without storing anything, and identical wherever it's computed. Dataflare hashes the device id rather than the user id because the device id doesn't change at login, so signing in never flips someone's variant. `bucketBy: "person"` hashes the person instead (the same value on every device once they've signed in), and `bucketBy: "company"` (a group type) gives everyone in a company the same value.
- **Rules** are checked in order; the first rule whose conditions all match sets the rollout (and optionally forces a variant). Conditions use the same property syntax as query filters: `person.*`, `group.company.*`, `country`, `region`, `city`, `device`, `browser`, `os`, `url`, membership of a cohort (`{"property":"cohort","value":"beta-testers"}`), and other flags (`{"flag":"new-nav","value":"on"}`, checked for loops).
- **Payloads**: `payloads` attaches JSON (up to 10 KB) to each value (`"on"` or a variant key); the SDK reads it with `glass.flagPayload(key)`.
- **Early access**: `earlyAccess: { name, description, docsUrl, stage }` lets people opt in from your app (`glass.optIn(key)`); see the [SDK](sdk.md#feature-flags).
- **Schedules**: `schedule_flag_change` turns a flag on or off, or changes its rollout or weights, at a time; the five-minute maintenance job applies it.
- **History and usage**: every change is kept with before and after (`flag_history`), and `flag_usage` shows evaluations and exposures over time by value.
- **Debugging**: `POST /f?debug=1` (or `evaluate_flags`) says which rule matched for a person.
- Change the `salt` to reshuffle everyone.

Server code can evaluate flags without a request per check with [`dataflare-node`](node-sdk.md), which polls the definitions and gives the same answers as the Worker.

```sh
npx dataflare-cli flags set beta-editor --rollout 10
npx dataflare-cli flags set beta-editor --rules '[{"conditions":[{"property":"person.plan","value":"pro"}],"rollout":100}]'
```

## Experiments

An experiment is a multivariate flag plus the metrics it is judged on:

```sh
npx dataflare-cli experiments create checkout-v2 --goal purchase_completed --hypothesis "A one-page checkout converts better"
```

This creates the experiment as a draft, plus a `checkout-v2` flag with `control` and `test` at 50/50, disabled until you start. In code, read the flag where the variant is shown:

```js
if (glass.flag('checkout-v2') === 'test') renderOnePageCheckout();
```

Then `npx dataflare-cli experiments start checkout-v2`, wait, and read `npx dataflare-cli experiments results checkout-v2`. Ship the winner with `npx dataflare-cli experiments ship checkout-v2 test`; everyone gets that variant from then on.

### Metrics

`metrics` (primary: the first decides) and `secondary` (guardrails, reported but never deciding) take any of:

| `kind`       | Per person (or group)                                                                                          |
| ------------ | -------------------------------------------------------------------------------------------------------------- |
| `conversion` | Did the event after exposure (optionally `within` a time)                                                      |
| `mean`       | How many times they did it, or the sum of a property; `winsorize` caps outliers at the 95th or 99th percentile |
| `ratio`      | One count or sum divided by another (e.g. revenue per session), with delta-method variance                     |
| `funnel`     | Completed `steps` after exposure, within a `window`                                                            |
| `retention`  | Came back and did the event between `from` and `to` after exposure                                             |

Each metric has a `goal`: `increase` (default) or `decrease` (for errors or refunds).

### Options

- `engine`: `bayesian` (default; probability to beat control and to be best) or `frequentist` (p-values and confidence intervals), at a `confidence` of 0.9, 0.95 or 0.99.
- `minimumDays`: no winner is declared before it has run this long.
- `holdout`: a holdout (`save_holdout`) keeps a share of people out of every experiment that uses it; `holdout_results` compares them with everyone else to measure the combined effect of what you ship.
- Web experiments: give a variant `transforms` (CSS selector plus new text, HTML, style, attributes or hide) and the SDK changes the page, with no code. There's no visual editor.
- Lifecycle: `pause` (everyone gets the default experience), `resume`, `stop` (results freeze), `ship`, `reset` (back to draft, counting afresh from the next start), `archive`, and `duplicate_experiment`.
- `plan_experiment` estimates how long it needs to run to detect a given change, from the last 14 days of traffic and the metric's current value.

## How results are computed

- A person enters at their **first `$exposure`** to the flag (or a custom exposure event). People exposed to more than one variant are excluded and counted separately; if that number is large, the flag is being read inconsistently.
- Metrics count what people did **at or after** their first exposure.
- **Conversion rate** per variant comes with a Wilson interval. Means and ratios use normal posteriors (Bayesian) or Welch's t-test (frequentist).
- **Probability to beat control** and the **lift interval** come from a beta-binomial model with a uniform prior, estimated with 20,000 seeded Monte Carlo draws (the same data always gives the same numbers). The lift shown is the posterior median, which stays stable when control has few conversions.
- **Probability to be best** draws all variants together, so it doesn't favour the best of several by chance.
- **Sample ratio mismatch**: a chi-square test of exposures against the variant weights. If p < 0.001, Dataflare flags the experiment as broken and won't declare a winner, because assignment or exposure tracking is faulty.
- A **winner** is declared when the first primary metric clears the confidence and the minimum runtime has passed. Until then, Dataflare estimates the days needed to detect a 10% change at the current traffic, once control has a baseline.
- **Results over time**: a daily cumulative series for each metric.

The statistics live in `packages/core/src/stats/tests.ts`, with tests against reference values computed with SciPy.
