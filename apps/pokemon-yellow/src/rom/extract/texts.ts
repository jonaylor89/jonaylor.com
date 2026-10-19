import type { Rom } from '../Rom';
import type { TextOp } from '../../data/schema';
import { decodeTextCommands, TextDecodeError } from '../text';
import { sym, TEXT_LABELS, hasSymbol, allRomLabels } from '../symbols';

/**
 * Collects decoded text streams keyed by ROM label. Text referenced by maps
 * is added explicitly; every label in the dedicated text banks is decoded too,
 * so ported scripts can reference any original text by its label.
 */
export class TextCollector {
  readonly texts: Record<string, TextOp[]> = {};
  readonly failures: Record<string, string> = {};

  constructor(private readonly rom: Rom) {}

  add(label: string, offset?: number): TextOp[] | undefined {
    if (this.texts[label]) return this.texts[label];
    const off = offset ?? sym(label);
    try {
      const ops = decodeTextCommands(this.rom, off);
      this.texts[label] = ops;
      return ops;
    } catch (e) {
      if (!(e instanceof TextDecodeError)) throw e;
      this.failures[label] = e.message;
      return undefined;
    }
  }

  /** Decode a label that holds a bare string (no TX_START prefix), e.g. `_FooText` inside text banks. */
  addAllTextBankLabels(): void {
    for (const label of TEXT_LABELS) {
      if (!hasSymbol(label) || this.texts[label]) continue;
      const off = sym(label);
      // Text-bank labels point at raw text commands (text/line/para/... begin with TX_START).
      try {
        this.texts[label] = decodeTextCommands(this.rom, off);
      } catch (e) {
        if (!(e instanceof TextDecodeError)) throw e;
        this.failures[label] = e.message;
      }
    }
  }

  /**
   * Script code refers to text by label (`ld hl, .SomeText; call PrintText`).
   * Decode every label whose name says it is text, keeping only streams that
   * decode cleanly; ported scripts look texts up by these labels.
   */
  addScriptTextLabels(): void {
    for (const label of allRomLabels()) {
      if (this.texts[label] || !/Text|Txt|Sign$/.test(label)) continue;
      try {
        this.texts[label] = decodeTextCommands(this.rom, sym(label));
      } catch (e) {
        if (!(e instanceof TextDecodeError)) throw e;
      }
    }
  }
}
