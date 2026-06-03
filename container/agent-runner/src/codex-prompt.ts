export interface CodexPromptInput {
  prompt: string;
}

export function buildCodexPromptForSession(input: CodexPromptInput): string {
  return `<user-message>\n${input.prompt}\n</user-message>`;
}
