/** Interactive terminal contract owned by the OAuth bootstrap command. */
export interface BootstrapTerminalInput {
  readonly isTTY?: boolean;
  readonly setRawMode?: unknown;
}

export interface BootstrapTerminalOutput {
  readonly isTTY?: boolean;
}

export function requireInteractiveBootstrapTerminal(
  input: BootstrapTerminalInput,
  output: BootstrapTerminalOutput,
): void {
  if (
    input.isTTY !== true ||
    typeof input.setRawMode !== "function" ||
    output.isTTY !== true
  ) {
    throw new Error("Account bootstrap requires an interactive terminal.");
  }
}
