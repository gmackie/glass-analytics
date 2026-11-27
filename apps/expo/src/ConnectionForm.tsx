import { useState } from 'react';
import { KeyboardAvoidingView, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { type Connection, connectionFrom, pastedConnection, verifyConnection } from './data.ts';
import { saveConnection } from './session.ts';
import { themedStyles, useTheme } from './styles.ts';
import { Action } from './ui.tsx';
import { mobileUsage } from './usage.ts';

export function ConnectionForm({
  current,
  onCommit,
  close,
}: {
  current: Connection | null;
  onCommit: (connection: Connection | null) => void;
  close: () => void;
}) {
  const { color, scheme, ui } = useTheme();
  const styles = sheets[scheme];
  const [address, setAddress] = useState(
    current?.url ?? process.env.EXPO_PUBLIC_DATAFLARE_WORKER_URL ?? '',
  );
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [focused, setFocused] = useState<'url' | 'key' | null>(null);

  function changeKey(text: string) {
    setError('');
    try {
      const pasted = pastedConnection(text);
      if (pasted) setAddress(pasted.url);
      setKey(pasted?.key ?? text);
    } catch (cause) {
      setKey('');
      setError(cause instanceof Error ? cause.message : 'Check the pasted connection details.');
    }
  }

  async function submit(disconnect = false) {
    if (busy) return;
    setBusy(true);
    setError('');
    const mode = current ? 'live' : 'demo';
    if (!disconnect) mobileUsage.connection(mode, 'attempted');
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 20000);
    try {
      const next = disconnect ? null : connectionFrom(address, key);
      if (next) await verifyConnection(next, controller.signal);
      await saveConnection(next);
      if (next) mobileUsage.connection(mode, 'connected');
      onCommit(next);
    } catch (cause) {
      if (!disconnect) mobileUsage.connection(mode, 'failed');
      setError(
        controller.signal.aborted
          ? 'The Worker timed out. Check your connection and try again.'
          : cause instanceof Error
            ? cause.message
            : 'Could not update the connection. Try again.',
      );
    } finally {
      clearTimeout(timeout);
      setBusy(false);
    }
  }
  return (
    <SafeAreaView style={ui.screen}>
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
              style={[styles.input, focused === 'url' && styles.focused]}
              onFocus={() => setFocused('url')}
              onBlur={() => setFocused(null)}
              selectionColor={color.accent}
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
              style={[styles.input, focused === 'key' && styles.focused]}
              onFocus={() => setFocused('key')}
              onBlur={() => setFocused(null)}
              selectionColor={color.accent}
              editable={!busy}
              secureTextEntry
              textContentType="none"
              autoComplete="off"
              autoCapitalize="none"
              autoCorrect={false}
              value={key}
              onChangeText={changeKey}
              placeholder="Paste read key or connection details"
              placeholderTextColor={color.muted}
            />
            <Text style={ui.muted}>
              To fill in both fields, paste the output of{' '}
              <Text selectable style={styles.code}>
                dataflare key --read --json
              </Text>{' '}
              here. The key is saved in this device’s Keychain after you connect.
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
const sheets = themedStyles((color) =>
  StyleSheet.create({
    form: { alignSelf: 'center', width: '100%', maxWidth: 480, padding: 22, gap: 22 },
    top: { flexDirection: 'row', alignItems: 'center', gap: 12 },
    field: { gap: 8 },
    code: { fontFamily: 'Menlo' },
    input: {
      color: color.ink,
      backgroundColor: color.surface,
      borderWidth: 1,
      borderColor: color.hairlineStrong,
      borderRadius: 6,
      padding: 13,
      minHeight: 48,
      fontSize: 16,
    },
    focused: { borderColor: color.accent },
    error: { color: color.bad, fontSize: 15 },
  }),
);
