/** Strip ANSI CSI escape sequences (colors, styles, cursor codes) from captured CLI output. */
export function stripAnsi(output: string): string {
  let stripped = "";
  for (let i = 0; i < output.length; i++) {
    const charCode = output.charCodeAt(i);
    if (charCode !== 0x1b || output[i + 1] !== "[") {
      stripped += output[i];
      continue;
    }

    i += 2;
    while (i < output.length) {
      const code = output.charCodeAt(i);
      if (code >= 0x40 && code <= 0x7e) {
        break;
      }
      i++;
    }
  }
  return stripped;
}
