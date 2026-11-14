# dataflare-native

The client the Expo / React Native apps use to report to observe.gmac.io (DATFLR-14). It's the
mobile counterpart of the web journey loader (`deployments/observe/journey-loader/dataflare.js`):
the same `POST /e` wire format, the same event names, and identify/reset semantics.

It has no dependencies. Copy `src/dataflare-native.ts` into the app unchanged (for example
`lib/dataflare-native.ts`), the way apps copy `dataflare.js`, and configure it through
`createDataflare()`.

## What it sends

| Event       | Notes                                                                                    |
| ----------- | ---------------------------------------------------------------------------------------- |
| `$pageview` | One per screen, `url` = `app://<project>/<route>`; `(groups)` dropped, ids become `:id`. |
| app events  | `analytics.track('booking_created', { rooms: 2 })`                                       |
| `$identify` | `analytics.identify(user.id, { plan })` after sign-in; `reset()` on sign-out.            |

Every event carries `$os`, `$os_version`, `$app_version`, `$app_build` and `$lib`. The
User-Agent is `Dataflare-RN/<v> (iPhone; …)` / `(Linux; Android …; Mobile)`, so the dashboard's
OS and device breakdowns work, and the bot filter never drops it. Requests carry no `Origin`,
so project origin allow-lists don't apply. String props over 200 characters, and strings that
look like email addresses, are dropped; never pass names or free text.

Events are batched: every 10 s, at 20 queued events, and on `flush()`. Batches that fail with a
network error or 5xx are kept, up to 500 events, and retried.

## Wiring an Expo app

```ts
// lib/analytics.ts
import AsyncStorage from '@react-native-async-storage/async-storage'; // or any getItem/setItem/removeItem store
import * as Application from 'expo-application';
import { Platform } from 'react-native';
import { createDataflare } from './dataflare-native';

export type AppEvent = 'signup_started' | 'signup_completed' | 'booking_created';

export const analytics = createDataflare({
  project: 'latchflow', // the same observe project as the web app
  storage: AsyncStorage,
  app: { version: Application.nativeApplicationVersion, build: Application.nativeBuildVersion },
  platform: {
    os: Platform.OS,
    osVersion: Platform.Version,
    device: Platform.isPad ? 'tablet' : 'mobile',
  },
  enabled: process.env.EXPO_PUBLIC_DATAFLARE !== 'off',
});

export const track = (event: AppEvent, props?: Record<string, string | number | boolean | null>) =>
  analytics.track(event, props);
```

- **Screens (expo-router):** in the root `_layout.tsx`, run
  `const pathname = usePathname(); useEffect(() => analytics.screen(pathname), [pathname]);`.
  With React Navigation, call `screen(route.name)` from `onStateChange`.
- **Flush on background:** `AppState.addEventListener('change', (s) => s !== 'active' && analytics.flush())`.
- **Auth:** call `analytics.identify(user.id)` when a session starts or is restored, and
  `analytics.reset()` on sign-out. Use the opaque internal id only. Pass `identify: false` for
  apps that must not link activity to accounts.
- **Storage:** if the app has no AsyncStorage, use the store it already has (for example an
  `expo-secure-store` wrapper). Without storage, ids last for the process only.
