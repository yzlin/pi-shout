import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import { stripTerminalSequences, truncateToWidth, wrapTextWithAnsi } from '@earendil-works/pi-tui';

export const DICTATION_PREVIEW_WIDGET_KEY = 'pi-shout-dictation-preview';
const MAX_TEXT_LINES = 3;

function safePreviewText(text: string): string {
  return stripTerminalSequences(text)
    .replaceAll('\r\n', '\n')
    .replaceAll('\r', '\n')
    .replace(/[\x00-\x09\x0b\x0c\x0e-\x1f\x7f-\x9f]/gu, ' ');
}

function fitLine(text: string, width: number): string {
  return truncateToWidth(text, Math.max(1, width));
}

export function renderDictationPreview(
  width: number,
  options: { label: string; text: string; hint: string },
): string[] {
  const available = Math.max(1, width);
  const wrapped = wrapTextWithAnsi(safePreviewText(options.text), available);
  const textLines = wrapped.slice(0, MAX_TEXT_LINES).map(line => fitLine(line, available));
  if (wrapped.length > MAX_TEXT_LINES) {
    const last = textLines[MAX_TEXT_LINES - 1] ?? '';
    textLines[MAX_TEXT_LINES - 1] = available === 1
      ? '…'
      : `${truncateToWidth(last, available - 1)}…`;
  }
  return [
    fitLine(options.label, available),
    ...textLines,
    fitLine(options.hint, available),
  ];
}

export function showDictationPreview(
  ctx: ExtensionContext,
  options: { label: string; text: string; hint: string; observeEditor?: () => void },
): void {
  if (!ctx.hasUI || ctx.mode !== 'tui') return;
  ctx.ui.setWidget(DICTATION_PREVIEW_WIDGET_KEY, (_tui, theme) => ({
    render: width => {
      options.observeEditor?.();
      return renderDictationPreview(width, {
        label: theme.fg('accent', options.label),
        text: theme.fg('muted', safePreviewText(options.text)),
        hint: theme.fg('dim', options.hint),
      });
    },
    invalidate() {},
  }));
}

export function clearDictationPreview(ctx: ExtensionContext): void {
  if (!ctx.hasUI || ctx.mode !== 'tui') return;
  ctx.ui.setWidget(DICTATION_PREVIEW_WIDGET_KEY, undefined);
}
