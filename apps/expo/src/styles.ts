import { StyleSheet } from 'react-native';

export const color = {
  paper: '#f6f7f2',
  card: '#ffffff',
  ink: '#142e2b',
  muted: '#4f675e',
  line: '#d7e0d7',
  accent: '#28634f',
  forest: '#123c33',
  mint: '#adedd0',
};
export const formatNumber = new Intl.NumberFormat(undefined);
export const ui = StyleSheet.create({
  fill: { flex: 1 },
  body: { color: color.ink, fontSize: 16 },
  muted: { color: color.muted, fontSize: 14 },
  title: { fontSize: 30, fontWeight: '700', color: color.ink, letterSpacing: -1 },
  heading: { fontSize: 19, fontWeight: '600', color: color.ink },
  numeric: { fontVariant: ['tabular-nums'] },
  panel: {
    backgroundColor: color.card,
    borderRadius: 16,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.line,
    padding: 18,
    gap: 12,
  },
  button: {
    minHeight: 44,
    paddingHorizontal: 14,
    justifyContent: 'center',
    alignItems: 'center',
    borderRadius: 10,
    backgroundColor: '#e3eee5',
  },
  buttonText: { fontSize: 15, fontWeight: '600', color: color.accent },
  primary: { backgroundColor: color.forest },
  inverted: { color: '#fff' },
  row: { flexDirection: 'row', alignItems: 'center', gap: 10, flexWrap: 'wrap' },
  pad: { paddingHorizontal: 18, paddingVertical: 16, gap: 16 },
  pressed: { opacity: 0.65 },
});
