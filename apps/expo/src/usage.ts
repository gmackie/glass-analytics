import { createAppUsage } from '@dataflare/core/app-usage';
import Constants from 'expo-constants';
import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';
import { createDataflare } from '../../../packages/native/src/dataflare-native.ts';

const setting = process.env.EXPO_PUBLIC_DATAFLARE_ANALYTICS;
const observeBuild =
  process.env.EXPO_PUBLIC_DATAFLARE_WORKER_URL?.replace(/\/+$/, '') === 'https://observe.gmac.io';
const app = Constants.expoConfig;
const ios = Platform.OS === 'ios';
const client = createDataflare({
  project: 'dataflare',
  enabled: ios && setting !== 'off' && (observeBuild || setting === 'verification'),
  identify: false,
  platform: {
    os: Platform.OS,
    osVersion: Platform.Version,
    device: Platform.OS === 'ios' && Platform.isPad ? 'tablet' : 'mobile',
  },
  app: {
    version: app?.version,
    build: Constants.platform?.ios?.buildNumber ?? app?.ios?.buildNumber,
  },
  // SecureStore accepts dots, letters, numbers, dashes and underscores in its keys.
  storage: {
    getItem: (key) => SecureStore.getItemAsync(key.replaceAll(':', '.')),
    setItem: (key, value) =>
      SecureStore.setItemAsync(key.replaceAll(':', '.'), value, {
        keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
      }),
    removeItem: (key) => SecureStore.deleteItemAsync(key.replaceAll(':', '.')),
  },
});

export const mobileUsage = createAppUsage(
  'ios',
  __DEV__ || setting === 'verification' ? 'verification' : 'usage',
  (event, props) => {
    if (event === '$pageview') client.screen(String(props.screen), props);
    else client.track(event, props);
  },
);

export const flushUsage = () => client.flush();
