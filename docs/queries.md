# Queries

Every query is a JSON spec. The same specs work in the dashboard (they're in its URLs), the MCP tools, the CLI (`--spec`) and `POST /api/query`.

## Time ranges

`from` (inclusive) and `to` (exclusive) accept ISO dates (`2026-10-01`), epoch milliseconds, `now`, `today`, `yesterday`, or relative offsets (`-30d`, `-12h`, `-2w`, `-3mo`, `-1y`). The default is the last 30 days.

Days, weeks and months start at midnight in the project's time zone (Settings, or `update_settings` with `timezone: "Europe/London"`), and follow daylight saving: a day in London is 23 or 25 hours long on the changeover days. Override it per query with `timezone`. The older `utcOffsetMinutes` (a fixed offset) still works.

## Properties

| Written as                                                            | Means                                        |
| --------------------------------------------------------------------- | -------------------------------------------- |
| `path`, `url`, `host`, `referrer_host`, `title`                       | Page columns                                 |
| `utm_source`, `utm_medium`, `utm_campaign`, `utm_term`, `utm_content` | Campaign tags from the page URL              |
| `country`, `region`, `city`, `device`, `browser`, `os`                | From the request                             |
| `event`, `session_id`, `user_id`, `distinct_id`                       | Identity columns                             |
| `plan` or `props.plan`                                                | The event property `plan`                    |
| `props.address.city`                                                  | A nested event property                      |
| `person.plan`                                                         | The person's `plan` at the time of the event |
| `group.company`                                                       | The key of the event's `company` group       |
| `group.company.plan`                                                  | That group's `plan` at the time of the event |
| `session.utm_source`                                                  | The first value in the event's session       |

## Filters

```json
{ "property": "person.plan", "op": "eq", "value": "pro" }
```

Ops: `eq` (default), `neq`, `contains`, `not_contains`, `in`, `not_in`, `gt`, `gte`, `lt`, `lte`, `is_set`, `is_not_set`. Negative ops (`neq`, `not_contains`, `not_in`) include events where the property is missing. `contains` ignores case. Numeric comparisons apply to event and person properties.

`{"property": "cohort", "value": "power-users"}` keeps people in a saved cohort (`neq` for people outside it).

`"filterTestAccounts": true` on any query leaves out internal and test traffic, as defined once in the project's `internalFilters` setting (for example `person.email` contains `@acme.com`).

`"aggregateBy"` chooses what unique counts, funnels and retention count: `"person"` (default), `"session"`, or a group type such as `"company"`.

## Web

```json
{ "kind": "web", "from": "-7d", "filters": [{ "property": "utm_campaign", "value": "launch" }] }
```

Visitors are distinct devices; a session ends after 30 minutes of inactivity. Referrers and UTM tags are attributed to the session's first pageview, so a campaign visit counts once, not once per page. Bounce rate is the share of sessions with one pageview.

## Trends

```json
{
  "kind": "trends",
  "series": [
    { "event": "signup_completed", "math": "unique_persons" },
    { "event": "order_paid", "math": "sum", "property": "amount" }
  ],
  "formulas": [{ "expr": "B / A", "label": "Revenue per signup" }],
  "interval": "week",
  "breakdown": "utm_source",
  "from": "-90d"
}
```

`event` may be one name or a list (any of them). `math`:

| `math`                                                           | Counts                                                             |
| ---------------------------------------------------------------- | ------------------------------------------------------------------ |
| `total` (default)                                                | Events                                                             |
| `unique_persons` (`dau`), `unique_sessions`                      | Distinct people (or sessions) per interval                         |
| `wau`, `mau`                                                     | Distinct people in the 7 or 30 days up to each point               |
| `unique_groups` (with `groupType`)                               | Distinct groups, e.g. companies                                    |
| `first_time`                                                     | People doing it for the first time ever                            |
| `sum`, `avg`, `min`, `max`, `median`, `p75`, `p90`, `p95`, `p99` | Of a numeric `property`                                            |
| `avg_count_per_actor` (also `min`, `max`, `median`, `p75`…`p99`) | How many times each person did it                                  |
| `revenue`                                                        | Revenue in the project's base currency (see [revenue](revenue.md)) |

Percentiles and medians come from log-bucketed counts (about 1% relative error) so they run the same in D1 and the lake.

Options:

- `interval`: `minute` (ranges up to two days), `hour`, `day` (default), `week` or `month`.
- `formulas`: arithmetic over the series letters (A is the first), computed per interval and breakdown value. `formulaOnly` hides the series.
- `compare`: also return the previous period of the same length.
- `cumulative`: running totals. `smoothing: 7`: a moving average over that many intervals. `trendLine`: a least-squares fit per line.
- `breakdown`: one property, or up to four combined (`["browser","utm_source"]`). The top 10 values are kept (`breakdownLimit`, up to 50); for totals and sums the rest are combined as "Other". `breakdownBins: 10` groups a numeric property into ranges. `"breakdown": "cohort"` with `breakdownCohorts: ["a","b"]` compares saved cohorts.
- `display` (`line`, `area`, `bar`, `bar_value`, `table`, `pie`, `number`, `world_map`), `logScale`, `percentStack` and `showValues` only change how the dashboard draws it.

## Funnels

```json
{
  "kind": "funnel",
  "steps": [
    { "event": "$pageview", "filters": [{ "property": "path", "value": "/pricing" }] },
    { "event": "signup_started", "optional": true },
    { "event": "signup_completed" }
  ],
  "window": "7d",
  "order": "ordered",
  "exclusions": [{ "event": "coupon_applied", "fromStep": 1, "toStep": 3 }],
  "breakdown": "device"
}
```

Each step must happen after the previous one and within `window` of step 1. Every step-1 event starts an attempt, and each person (or session, or group, with `aggregateBy`) counts once, at their furthest attempt.

- `order`: `ordered` (default: other events may happen in between), `strict` (the next event must be the next step), or `unordered` (any order, within the window).
- `optional` on a step (not the first): people may skip it.
- `exclusions`: attempts where that event happened between `fromStep` and `toStep` don't count.
- `breakdownAttribution`: where the breakdown value comes from: `first_touch` (step 1, default), `last_touch` (the last step reached), `all_steps` (the same on every step) or a step number.
- `viz`: `steps` (default), `time_to_convert` (a histogram between `fromStep` and `toStep`, with median and average) or `trends` (conversion rate over time, by when people entered).

The result has counts, conversion from the start and from the previous step, and mean and median time between steps.

`"kind": "funnel_correlation"` takes the same spec and returns what goes with converting and with dropping off: other events people did (`"correlation": "events"`), or values of `properties` they had (`"correlation": "properties"`), ranked by odds ratio with a χ² significance test.

## Retention

```json
{
  "kind": "retention",
  "cohortEvent": { "event": "signup_completed" },
  "returnEvent": { "event": "$pageview" },
  "period": "week",
  "periods": 8,
  "from": "-90d"
}
```

A person's cohort is the period of their first `cohortEvent` in the range. Period 0 is the cohort itself; period _k_ counts people who did `returnEvent` _k_ periods later.

- `period`: `hour`, `day`, `week` (default) or `month`. Either event may be `"*"` (any event).
- `retentionType: "recurring"`: people join a cohort every period they do the cohort event, not just the first.
- `cumulative`: count a period if they came back then or any time later ("on or after").
- `meanMethod`: the average row weights cohorts by size (`weighted`, default) or not (`simple`). Either way it only includes cohorts old enough to have that period.
- `breakdown` (a property of the cohort event, or `"cohort"` with `breakdownCohorts`): one table per value.

## Paths

```json
{
  "kind": "paths",
  "start": { "type": "page", "value": "/pricing" },
  "steps": 5,
  "include": { "pages": true, "events": ["signup_completed"] },
  "from": "-30d"
}
```

The journeys people take, as steps and the links between them. Each person's first path in the range counts once (`aggregateBy: "session"` counts every visit). The result has `nodes` (a step at a column: `id` like `"2:/pricing"`, `count`, `dropOff`), `links` (`source`, `target`, `count`, `avgSeconds`) and `topPaths`, the 50 most common whole paths.

- `include`: page views (by path, the default), custom events (`true` or a list of names), or both. Dataflare's own events (`$pageleave`, `$web_vitals`, clicks…) are never steps.
- `start` / `end`: a page or an event where paths begin or finish. With only `end`, the chart runs backwards to it; with both, only paths that got from one to the other count, and they stop at the end. `"*"` matches anything: `"/blog/*"`.
- `steps`: 2 to 10 (default 5). `collapseRepeats` (default true) counts a page reloaded twice in a row once.
- `exclude`: pages or events to leave out. `groups`: patterns shown as one step (`"/blog/*"`).
- `cleaning`: rules for this query, `[{ "match": "/users/*/settings", "alias": "/users/:id/settings" }]`; the project's `pathCleaning` setting applies too unless `projectCleaning: false`. `suggest_path_rules` (`GET /api/paths/suggest-rules`) proposes rules for paths with ids in them.
- `boundary`: `"session"` (default) keeps a path inside one visit; `{ "minutes": 1440 }` lets it run across visits for that long.
- `perStep` (default 8): the most common steps per column; the rest are `Other`. `minPeople` / `maxPeople` hide links outside that range.
- `funnel: { spec, step, mode }`: paths around a funnel step. `after` (what people did after reaching it), `before` (what led up to it), `between` (between it and the next step), `dropoff` (what people who reached the step before did instead). Ordered or strict funnels only.

## Who is behind a number

`POST /api/actors` (MCP `list_actors`) takes any trends, funnel, retention or paths spec and a `selection`:

- a trends series and bucket;
- a funnel step's converters or drop-offs;
- a retention cell (cohort start and period);
- a paths step (`node`), a link (`node` and `target`), or the people who stopped at a step (`node` and `dropOff: true`).

It returns those people with their properties and replay counts, as JSON or CSV. `save_actors_as_cohort` keeps them as a static cohort.

## Cohorts

A cohort is groups of conditions: a person must match all (or any) of the groups, and each group all (or any) of its conditions.

```json
{
  "name": "Power users",
  "definition": {
    "groups": [
      {
        "conditions": [
          {
            "type": "performed",
            "event": "report_created",
            "count": { "op": "gte", "value": 3 },
            "within": "30d"
          },
          { "type": "property", "property": "person.plan", "op": "in", "value": ["pro", "team"] }
        ]
      }
    ]
  }
}
```

| `type`                | Matches people who…                                                          |
| --------------------- | ---------------------------------------------------------------------------- |
| `property`            | have a person property value                                                 |
| `performed`           | did an event at least, exactly or at most N times within a window            |
| `not_performed`       | didn't do it within the window                                               |
| `performed_regularly` | did it in at least K of the last N days, weeks or months                     |
| `first_performed`     | did it for the first time ever within the window                             |
| `stopped`, `started`  | did it in the earlier window but not the recent one (or the other way round) |
| `sequence`            | did one event and then another within a gap                                  |
| `cohort`              | are (or aren't) in another saved cohort; loops are refused                   |

Behaviour conditions take event `filters` too. `"static": true` with `ids` saves a fixed list instead (up to 10,000 people), edited with `edit_cohort_members`. `duplicate_cohort` copies any cohort as a static list of today's members. Flags can target cohorts: the membership of the ones flags use is recomputed at least hourly (when saved, and then by the five-minute maintenance job, a few at a time).

## Revenue

`"kind": "revenue"` reports gross and net revenue, refunds, orders, paying customers and ARPU, and from subscriptions MRR, ARR and its movements (new, expansion, contraction, churned, reactivated), churn and LTV. It can break down by product, first-touch source, country or any property, and lists top customers (or accounts, with `aggregateBy`). See [revenue](revenue.md).

## Annotations

Notes pinned to moments (`create_annotation` with `at` and `text`) show on every time chart, or on one saved insight. `list_annotations` returns them for a range.

## SQL

```json
{
  "query": "SELECT browser, COUNT(DISTINCT distinct_id) AS visitors FROM events WHERE project = 'my-app' AND ts_ms >= 1767225600000 GROUP BY browser",
  "limit": 100
}
```

One read-only `SELECT` (or `WITH … SELECT`). In D1 mode you can read `events`, `identities`, `persons`, `flags`, `experiments`, `replays` and `event_definitions`; in lake mode, `<namespace>.events` and `<namespace>.identities`. `ts_ms` is epoch milliseconds; `props`, `person_props` and `flags` are JSON (`json_extract(props, '$.plan')` in D1, `json_get_str(props, 'plan')` in the lake).

Each query result's `sql` field shows exactly what ran, which is the easiest way to learn the schema.
