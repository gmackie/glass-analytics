# Revenue analytics

Record payments as events, from your code or from Stripe, and Dataflare reports revenue, MRR and its movements, churn and LTV, by product, source, country, person or account.

## Revenue events

In Settings › Revenue, set the base currency and list the events that carry money:

| Field                  | Means                                                                        |
| ---------------------- | ---------------------------------------------------------------------------- |
| `event`                | e.g. `order_paid`                                                            |
| `amountProperty`       | The amount in major units (49.99)                                            |
| `currencyProperty`     | The property with its ISO currency code; or a fixed `currency` for the event |
| `productProperty`      | The product or plan, for revenue by product                                  |
| `subscriptionProperty` | A subscription id: each event sets that subscription's MRR (0 cancels it)    |
| `interval`             | `month` (default) or `year`, the billing interval for MRR                    |
| `kind`                 | `sale` (default) or `refund` (counted as negative)                           |

At ingest each revenue event gets `$revenue_base`: its amount converted to the base currency at the European Central Bank rate for the payment's day. Rates are fetched daily, and back-filled for imports. Because the converted amount is on the event, revenue queries are the same in D1 and the lake.

## Stripe

Settings › Stripe (or `connect_stripe`) gives you a webhook URL, `/hooks/stripe/<project>`. Add it in Stripe with these events: `invoice.paid`, `charge.succeeded`, `charge.refunded`, `customer.subscription.created`, `customer.subscription.updated`, `customer.subscription.deleted`, `customer.created` and `customer.updated`. Paste the signing secret. Dataflare checks every request's `Stripe-Signature` and turns the events into revenue events, refunds and subscription changes.

To tie payments to people, name the customer metadata key that holds your user id (what you pass to `glass.identify`). Two more options:

- Match by email instead: the email is hashed for matching and never stored.
- Give a restricted key with read access to Customers, to look up customers whose metadata is missing.

Name a group type and metadata key to tie customers to accounts too. Backfill history with `npx dataflare-cli stripe import --api-key rk_live_…`.

## Reports

`"kind": "revenue"` (the Revenue page, MCP `query_revenue`) returns, per day, week or month:

- gross revenue, refunds, net revenue, orders, paying customers and ARPU;
- MRR and ARR, with new, expansion, contraction, churned and reactivated MRR;
- revenue churn and customer churn, and LTV;
- a breakdown by product, first-touch channel, referrer, UTM tag, entry page, country, or any person or group property;
- the top customers, or the top accounts with `aggregateBy: "company"`.

Revenue also appears elsewhere:

- Trends: `"math": "revenue"`.
- Reports by source: revenue and revenue per visitor.
- People: each person's lifetime revenue.
- Groups: each account's net revenue and MRR.
