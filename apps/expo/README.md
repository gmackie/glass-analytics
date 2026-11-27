# Dataflare for iPhone

View the sites on a Dataflare Worker, compare traffic over 7, 30 or 90 days, and open a site for visitor trends, pageviews, sessions, bounce rate and top pages. The iPhone Duo shows the site picker and report together when space permits. In a partially folded window, each pane scrolls on its own side of the fold.

Open a site and tap **Paths** for its visitor Sankey. Swipe across the chart for later steps, then tap a step for arrivals and drop-offs or a band for its person count, share and average transition time. **Pages + events** includes custom events. **Top paths** ranks whole journeys by people. Each analysis follows the first path per person in the selected period, up to four steps in one session.

In **Overview**, switch between **Visitors** and **Pageviews** to compare with the previous period. Tap **Top pages** to choose entry pages, exit pages, referrers, UTM tags, countries, devices, browsers or operating systems.

The app follows the iPhone’s appearance by default. Tap the half-filled circle beside **Connect** or **Connection** to choose **System**, **Light**, or **Dark**. Your choice is saved on this device.

## Run on iPhone Duo

Use the Node and pnpm versions in the root package manifest, CocoaPods, and Xcode 27.1 or newer with the iPhone Duo simulator runtime installed. From the repository root, run

```sh
pnpm install --frozen-lockfile
pnpm --filter @dataflare/mobile ios --device "iPhone Duo" --configuration Release
```

The Release build embeds the JavaScript bundle. For development, omit `--configuration Release` to run with Metro and Fast Refresh.

## Connect a Worker

On first launch, the app shows the public Dataflare demo’s recorded reports. From the deployment directory on your Mac, run `dataflare key --read --json | pbcopy`. On the iPhone, tap **Connect** and paste into **Read key**. With Universal Clipboard enabled, this fills in both the Worker URL and the key. Check the address and tap **Connect to Worker**. You can also enter your Worker URL and paste a plain read key. Workers served under `/_glass` use that prefix in the URL. The app saves the verified connection in the device Keychain. **Connection → Disconnect** clears it and returns to the demo.

For a build dedicated to one deployment, set `EXPO_PUBLIC_DATAFLARE_WORKER_URL` when building the app to prefill its editable Worker URL. The owner’s Duo uses `https://observe.gmac.io`. Supply the read key on the device.

To try a local Worker, run `pnpm dev` at the repository root. In a simulator on the same Mac, connect to `http://127.0.0.1:8787` with `dev-read-key`. Deployed Workers use HTTPS.

## Starter

The Expo Router entry, native-stack layout, React Query provider, SecureStore integration and Xcode pod deployment-target plugin come from the mobile profile of create-gmacko-app 0.3.0. The app uses Dataflare’s existing bearer-key API. The starter’s MIT license is included alongside the app. [create-gmacko-app](https://www.npmjs.com/package/create-gmacko-app/v/0.3.0)

## App analytics

The Observe build sends anonymous usage to the `dataflare` project on Observe. It counts opening the app, successful report views, path drill-downs and connection attempts and outcomes. Reports distinguish demo from live data and record whether any data was present. The selected site, URL, key, path labels and report contents stay on the device. A random install ID is stored separately from the connection. Backgrounding the app flushes queued events.

Build with `EXPO_PUBLIC_DATAFLARE_WORKER_URL=https://observe.gmac.io` for the owner's configuration. Set `EXPO_PUBLIC_DATAFLARE_ANALYTICS=off` to disable collection, or `verification` for an instrumented test build. Development builds of this configuration also label their events as verification. Ordinary usage charts filter those visits out.
