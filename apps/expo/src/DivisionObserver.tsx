import { requireNativeView } from 'expo';
import type { NativeSyntheticEvent, ViewProps } from 'react-native';
import type { Region } from './layout.ts';

export const DivisionObserver = requireNativeView<
  ViewProps & {
    onDivisionChange: (event: NativeSyntheticEvent<{ region: Region | null }>) => void;
  }
>('DisplayDivision');
