import { useState } from 'react';
import { KeyboardAvoidingView, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { type Connection, connectionFrom, verifyConnection } from './data.ts';
import { saveConnection } from './session.ts';
import { color, ui } from './styles.ts';
import { Action } from './ui.tsx';

export function ConnectionForm({
  current,
  onCommit,
  close,
}: {
  current: Connection | null;
  onCommit: (connection: Connection | null) => void;
  close: () => void;
}) {
  const [address, setAddress] = useState(current?.url ?? 'https://observe.gmac.io');
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function submit(disconnect = false) {
    if (busy) return;
    setBusy(true);
    setError('');
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 20000);
    try {
      const next = disconnect ? null : connectionFrom(address, key);
      if (next) await verifyConnection(next, controller.signal);
      await saveConnection(next);
      onCommit(next);
    } catch (cause) {
      setError(
        controller.signal.aborted
          ? 'The Worker timed out. Check your connection and try again.'
          : cause instanceof Error
            ? cause.message
            : 'Could not update the connection. Try again.',
      );
      setBusy(false);
    } finally {
      clearTimeout(timeout);
    }
  }
  return (
    <SafeAreaView style={[ui.fill, styles.sheet]}>
      <KeyboardAvoidingView style={ui.fill} behavior="padding">
        <ScrollView contentContainerStyle={styles.form} keyboardShouldPersistTaps="handled">
          <View style={styles.top}>
            <Text accessibilityRole="header" style={[ui.title, ui.fill]}>
              Connection
            </Text>
            <Action onPress={close} disabled={busy}>
              Close
            </Action>
          </View>
          <Text style={ui.body}>
            Connect to your Dataflare Worker to view its sites and traffic.
          </Text>
          <View style={styles.field}>
            <Text style={ui.heading}>Worker URL</Text>
            <TextInput
              accessibilityLabel="Worker URL"
              style={styles.input}
              editable={!busy}
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="url"
              value={address}
              onChangeText={setAddress}
              placeholder="https://your-worker.workers.dev"
              placeholderTextColor={color.muted}
            />
          </View>
          <View style={styles.field}>
            <Text style={ui.heading}>Read key</Text>
            <TextInput
              accessibilityLabel="Read key"
              style={styles.input}
              editable={!busy}
              secureTextEntry
              textContentType="none"
              autoComplete="off"
              autoCapitalize="none"
              autoCorrect={false}
              value={key}
              onChangeText={setKey}
              placeholder="Enter read key"
              placeholderTextColor={color.muted}
            />
            <Text style={ui.muted}>
              Run{' '}
              <Text selectable style={styles.code}>
                dataflare key --read
              </Text>{' '}
              in the connected project. The key is saved in this device’s Keychain.
            </Text>
          </View>
          {error ? (
            <Text accessibilityRole="alert" style={styles.error}>
              {error}
            </Text>
          ) : null}
          <Action
            primary
            disabled={!address.trim() || !key.trim() || busy}
            onPress={() => void submit()}
          >
            {busy ? 'Connecting…' : 'Connect to Worker'}
          </Action>
          {current ? (
            <Action disabled={busy} onPress={() => void submit(true)}>
              Disconnect
            </Action>
          ) : null}
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}
const styles = StyleSheet.create({
  sheet: { backgroundColor: color.paper },
  form: { alignSelf: 'center', width: '100%', maxWidth: 480, padding: 22, gap: 22 },
  top: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  field: { gap: 8 },
  code: { fontFamily: 'Menlo' },
  input: {
    color: color.ink,
    backgroundColor: color.card,
    borderWidth: 1,
    borderColor: '#99b0a3',
    borderRadius: 10,
    padding: 13,
    minHeight: 48,
    fontSize: 16,
  },
  error: { color: '#963e29', fontSize: 15 },
});
