# Alerts

An alert watches a saved analysis and tells your channels when a number crosses a line, and again when it comes back.

## What an alert watches

- **Trends:** one series (A, B…). With a breakdown, every value is checked and any of them can fire ("Chrome is above 1,000").
- **Funnels:** conversion from the first step to a step (default: the last).

Paths and retention can't be alerted on.

## Conditions

- **is above / is below** a value: `{ "type": "value", "above": 1000 }`. For funnels the value is a rate: `{ "type": "value", "below": 0.05 }` is 5%.
- **rises by / falls by** an amount, or a percentage, compared with the bucket before: `{ "type": "decrease", "by": 20, "unit": "percent" }`.

By default the last complete bucket (yesterday, last hour) is checked. **Check the period still filling up** (`ongoing`) checks today, or this hour, as it stands.

## When it checks

Hourly (at a minute), daily, weekly or monthly, like [reports](dashboards.md#scheduled-reports). **Quiet hours** (up to five windows, which may cross midnight) and **skip weekends** skip the check, in the project's time zone.

## What it sends

A message when it **starts firing** (with the values that crossed the line) and when it **resolves**. Checks in between send nothing. Alerts go to up to five channels: Slack, Discord, Teams, webhooks and email.

Every check is kept for 90 days (`get_alert` / `GET /api/alerts/:id`), and the dialog draws them. An alert whose analysis is deleted, or turned into a kind that can't be alerted on, turns itself off and shows why.

## For agents

`save_alert`, `list_alerts`, `get_alert`, `check_alert`, `delete_alert`. For example: _"Alert #growth in Slack when daily signups fall by 30% or more"_:

```json
{
  "name": "Signups dropped",
  "insightKey": "signups-per-day",
  "condition": { "type": "decrease", "by": 30, "unit": "percent" },
  "schedule": { "frequency": "daily", "time": "08:00" },
  "channels": { "destinations": ["<id from list_destinations>"] }
}
```
