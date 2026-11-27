import { DarkTheme, DefaultTheme, Stack, ThemeProvider } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useLayoutEffect } from 'react';
import { restoreAppearance } from '../appearance.ts';
import { useTheme } from '../styles.ts';

export default function RootLayout() {
  const { color, scheme } = useTheme();
  const dark = scheme === 'dark';
  const statusBarStyle = dark ? 'light' : 'dark';
  useLayoutEffect(restoreAppearance, []);
  return (
    <ThemeProvider value={dark ? DarkTheme : DefaultTheme}>
      <Stack
        screenOptions={{
          headerShown: false,
          statusBarStyle,
          contentStyle: { backgroundColor: color.field },
        }}
      />
      <StatusBar style={statusBarStyle} />
    </ThemeProvider>
  );
}
