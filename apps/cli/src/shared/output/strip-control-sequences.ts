/* oxlint-disable no-control-regex -- these patterns intentionally match terminal control bytes */
const OSC_SEQUENCE = /\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)?/gu;
const CSI_SEQUENCE = /\u001b\[[0-?]*[ -/]*[@-~]/gu;
const ESCAPE_SEQUENCE = /\u001b[@-Z\\-_]/gu;
const CRLF_PAIR = /\u000d\u000a/gu;
const C0_CONTROLS = /[\u0000-\u0008\u000b-\u001f\u007f]/gu;
/* oxlint-enable no-control-regex */

/** Removes terminal control sequences while preserving tabs and newlines. */
export function stripControlSequences(message: string): string {
  return message
    .replaceAll(CRLF_PAIR, "\n")
    .replaceAll(OSC_SEQUENCE, "")
    .replaceAll(CSI_SEQUENCE, "")
    .replaceAll(ESCAPE_SEQUENCE, "")
    .replaceAll(C0_CONTROLS, "");
}
