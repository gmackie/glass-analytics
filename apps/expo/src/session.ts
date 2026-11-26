import * as SecureStore from 'expo-secure-store';
import { z } from 'zod/v4';
import { type Connection, connectionFrom } from './data.ts';

// Store the origin and its key together so changing Workers cannot leave them mismatched.
const storageKey = 'dataflare.connection.v1';

export async function loadConnection(): Promise<Connection | null> {
  const value = await SecureStore.getItemAsync(storageKey);
  if (value === null) return null;
  const saved = z.object({ url: z.string(), key: z.string() }).parse(JSON.parse(value));
  return connectionFrom(saved.url, saved.key);
}

export async function saveConnection(connection: Connection | null) {
  if (!connection) return SecureStore.deleteItemAsync(storageKey);
  await SecureStore.setItemAsync(storageKey, JSON.stringify(connection), {
    keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
  });
}
