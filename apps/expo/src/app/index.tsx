import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { Modal, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { ConnectionForm } from '../ConnectionForm.tsx';
import type { Connection } from '../data.ts';
import { loadConnection } from '../session.ts';
import { color, ui } from '../styles.ts';
import { Action, Loading, Notice } from '../ui.tsx';
import { Workspace } from '../Workspace.tsx';

type Session = { connection: Connection | null; client: QueryClient; id: number };
function session(connection: Connection | null, id: number): Session {
  // A new session gets an empty cache, including when a key changes on the same Worker.
  return {
    connection,
    id,
    client: new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 60000 } } }),
  };
}

export default function Dashboard() {
  const [current, setCurrent] = useState<Session | null>(null);
  const [storageError, setStorageError] = useState(false);
  const [editing, setEditing] = useState(false);
  useEffect(() => {
    let mounted = true;
    loadConnection()
      .then((connection) => {
        if (mounted) setCurrent(session(connection, 0));
      })
      .catch(() => {
        if (mounted) setStorageError(true);
      });
    return () => {
      mounted = false;
    };
  }, []);
  const commit = (connection: Connection | null) => {
    setCurrent((previous) => session(connection, (previous?.id ?? 0) + 1));
    setStorageError(false);
    setEditing(false);
  };
  return (
    <SafeAreaView style={[ui.fill, { backgroundColor: color.paper }]}>
      {current ? (
        <QueryClientProvider key={current.id} client={current.client}>
          <Workspace connection={current.connection} configure={() => setEditing(true)} />
        </QueryClientProvider>
      ) : storageError ? (
        <View style={ui.pad}>
          <Notice title="Couldn’t open the saved connection">
            Reconnect to your Worker to replace its saved settings.
          </Notice>
          <Action onPress={() => setEditing(true)}>Reconnect</Action>
        </View>
      ) : (
        <Loading label="Opening Dataflare…" />
      )}
      {editing ? (
        <Modal
          visible
          animationType="slide"
          presentationStyle="pageSheet"
          onRequestClose={() => setEditing(false)}
        >
          <ConnectionForm
            current={current?.connection ?? null}
            onCommit={commit}
            close={() => setEditing(false)}
          />
        </Modal>
      ) : null}
    </SafeAreaView>
  );
}
