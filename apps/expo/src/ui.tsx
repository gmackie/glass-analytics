import type { ReactNode } from 'react';
import { ActivityIndicator, Image, Pressable, StyleSheet, Text, View } from 'react-native';
import { type Period, periods } from './data.ts';

import { color, ui } from './styles.ts';

export function Action({
  children,
  onPress,
  primary,
  disabled,
}: {
  children: string;
  onPress: () => void;
  primary?: boolean;
  disabled?: boolean;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled: Boolean(disabled) }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        ui.button,
        primary && ui.primary,
        (pressed || disabled) && ui.pressed,
      ]}
    >
      <Text style={[ui.buttonText, primary && ui.inverted]}>{children}</Text>
    </Pressable>
  );
}

export function Brand({ live, configure }: { live: boolean; configure: () => void }) {
  return (
    <View style={styles.brand}>
      <View style={styles.identity}>
        <Image
          source={require('../assets/icon.png')}
          style={styles.mark}
          accessible={false}
          accessibilityElementsHidden
        />
        <View style={styles.wordmark}>
          <Text style={ui.heading}>Dataflare</Text>
          <Text style={ui.muted}>{live ? 'Connected' : 'Demo workspace'}</Text>
        </View>
      </View>
      <Action onPress={configure}>{live ? 'Connection' : 'Connect'}</Action>
    </View>
  );
}

export function PeriodPicker({
  value,
  onChange,
}: {
  value: Period;
  onChange: (days: Period) => void;
}) {
  return (
    <View style={styles.periods}>
      {periods.map((days) => (
        <Pressable
          key={days}
          accessibilityRole="button"
          accessibilityState={{ selected: value === days }}
          onPress={() => onChange(days)}
          style={({ pressed }) => [
            styles.period,
            days === value && styles.activePeriod,
            pressed && ui.pressed,
          ]}
        >
          <Text style={[ui.buttonText, days === value && ui.inverted]}>{days} days</Text>
        </Pressable>
      ))}
    </View>
  );
}

export function Notice({
  title,
  children,
  retry,
}: {
  title: string;
  children?: ReactNode;
  retry?: () => void;
}) {
  return (
    <View style={ui.panel}>
      <Text accessibilityRole="header" style={ui.heading}>
        {title}
      </Text>
      {children ? (
        <Text accessibilityLiveRegion="polite" style={ui.muted}>
          {children}
        </Text>
      ) : null}
      {retry ? <Action onPress={retry}>Try again</Action> : null}
    </View>
  );
}

export function Loading({ label }: { label: string }) {
  return (
    <View style={[ui.pad, ui.row]}>
      <ActivityIndicator color={color.accent} />
      <Text style={ui.muted}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  brand: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
    flexWrap: 'wrap',
    paddingHorizontal: 18,
    paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderColor: color.line,
  },
  identity: { flexDirection: 'row', gap: 8, alignItems: 'center', flexShrink: 1 },
  wordmark: { flexShrink: 1 },
  mark: { width: 30, height: 30, borderRadius: 7 },
  periods: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    padding: 3,
    borderRadius: 12,
    backgroundColor: '#e7ede5',
    alignSelf: 'flex-start',
  },
  period: { paddingHorizontal: 14, minHeight: 44, justifyContent: 'center', borderRadius: 9 },
  activePeriod: { backgroundColor: color.forest },
});
