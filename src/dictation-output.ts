import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import { isKeyRelease } from '@earendil-works/pi-tui';

// Pi pasteToEditor uses terminal bracketed paste; an embedded terminator must never reach it.
export function safeEditorText(text: string): boolean {
  return !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/u.test(text) && !text.includes('\x1b[201~');
}

export class DictationDestination {
  private readonly session: string;
  private readonly leaf: string | null;
  private readonly text: string;
  private dirty = false;
  private readonly unlisten: () => void;
  constructor(private readonly ctx: ExtensionContext) {
    this.session = ctx.sessionManager.getSessionId();
    this.leaf = ctx.sessionManager.getLeafId();
    this.text = ctx.ui.getEditorText();
    if (!ctx.hasUI || ctx.mode !== 'tui') { this.dirty = true; this.unlisten = () => {}; }
    else this.unlisten = ctx.ui.onTerminalInput((data) => {
      // Pi exposes key releases to listeners before filtering them from editor input.
      if (!isKeyRelease(data)) this.dirty = true;
      return undefined;
    });
  }
  wasEmpty(): boolean { return this.text.length === 0; }
  unchanged(): boolean {
    try {
      return !this.dirty && this.ctx.sessionManager.getSessionId() === this.session &&
        this.ctx.sessionManager.getLeafId() === this.leaf && this.ctx.ui.getEditorText() === this.text;
    } catch { return false; }
  }
  dispose(): void { this.unlisten(); }
}
