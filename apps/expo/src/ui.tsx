import type { ReactNode } from 'react';
import { ActivityIndicator, Image, Pressable, StyleSheet, Text, View } from 'react-native';
import { showAppearancePicker } from './appearance.ts';
import { type Period, periods } from './data.ts';
import { themedStyles, useTheme } from './styles.ts';

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
  const { ui } = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled: Boolean(disabled) }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        ui.button,
        primary && ui.primary,
        pressed && ui.pressed,
        disabled && ui.disabled,
      ]}
    >
      <Text style={[ui.buttonText, primary && ui.inverted]}>{children}</Text>
    </Pressable>
  );
}

export function Brand({ live, configure }: { live: boolean; configure: () => void }) {
  const { scheme, ui } = useTheme();
  const styles = sheets[scheme];
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
          <Text style={styles.brandName}>Dataflare</Text>
          <Text style={ui.caption}>{live ? 'Connected' : 'Demo workspace'}</Text>
        </View>
      </View>
      <View style={styles.actions}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Appearance"
          accessibilityHint="Choose System, Light, or Dark"
          onPress={(event) => showAppearancePicker(event.nativeEvent.target)}
          style={({ pressed }) => [styles.appearanceButton, pressed && ui.pressed]}
        >
          <View accessible={false} style={styles.appearanceIcon}>
            <View style={styles.appearanceHalf} />
          </View>
        </Pressable>
        <Action onPress={configure} primary={!live}>
          {live ? 'Connection' : 'Connect'}
        </Action>
      </View>
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
  const { scheme, ui } = useTheme();
  const styles = sheets[scheme];
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
          <Text style={[styles.periodLabel, days === value && styles.selectedLabel]}>
            {days} days
          </Text>
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
  const { ui } = useTheme();
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
  const { color, ui } = useTheme();
  return (
    <View style={[ui.pad, ui.row]}>
      <ActivityIndicator color={color.accent} />
      <Text style={ui.muted}>{label}</Text>
    </View>
  );
}

const sheets = themedStyles((color) =>
  StyleSheet.create({
    brand: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: 6,
      flexWrap: 'wrap',
      paddingHorizontal: 12,
      paddingVertical: 10,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderColor: color.hairline,
      backgroundColor: color.surface,
    },
    identity: {
      flexDirection: 'row',
      gap: 8,
      alignItems: 'center',
      flexBasis: 118,
      flexGrow: 1,
      flexShrink: 1,
    },
    wordmark: { flexShrink: 1 },
    brandName: { color: color.ink, fontSize: 17, fontWeight: '700', letterSpacing: -0.3 },
    mark: { width: 26, height: 26, borderRadius: 6 },
    actions: { flexDirection: 'row', alignItems: 'center', gap: 4 },
    appearanceButton: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
    appearanceIcon: {
      width: 18,
      height: 18,
      borderRadius: 9,
      borderWidth: 1.5,
      borderColor: color.ink2,
      overflow: 'hidden',
      justifyContent: 'center',
    },
    appearanceHalf: { width: '50%', height: '100%', backgroundColor: color.ink2 },
    periods: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      padding: 3,
      gap: 2,
      borderRadius: 9,
      backgroundColor: color.railActive,
      alignSelf: 'flex-start',
    },
    period: {
      paddingHorizontal: 12,
      minHeight: 44,
      justifyContent: 'center',
      borderRadius: 7,
      borderWidth: 1,
      borderColor: 'transparent',
    },
    activePeriod: { backgroundColor: color.surface, borderColor: color.hairline },
    periodLabel: { color: color.muted, fontSize: 14, fontWeight: '500' },
    selectedLabel: { color: color.ink, fontWeight: '600' },
  }),
);
