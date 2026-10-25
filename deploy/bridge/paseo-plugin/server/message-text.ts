/** Paseo 0.12 agent-messages/prepareAgentMessage wire contract (one XML escaping layer).
 * Human text resembling a reserved envelope arrives inside kind=user-message.
 * Unwrap exactly once: recursive stripping would corrupt a literal human message.
 */
export function messageText(raw: string, clientMessageId: string): string {
  const match = /^<paseo-system((?:\s+[a-z-]+="[^"<>]*")+)>\n([\s\S]*)\n<\/paseo-system>$/.exec(raw);
  if (!match) {
    // Native schedule notifications use this legacy reserved envelope. The human
    // send path quotes literal occurrences inside the versioned user envelope.
    if (/^<paseo-system>\n[\s\S]*\n<\/paseo-system>$/.test(raw)) throw new Error('System notifications do not send web messages');
    return raw;
  }
  const decode = (value: string): string | null => {
    if (/[<>]|&(?!amp;|lt;|gt;|quot;|apos;)/.test(value)) return null;
    const entities: Record<string, string> = {amp: '&', lt: '<', gt: '>', quot: '"', apos: "'"};
    return value.replace(/&(amp|lt|gt|quot|apos);/g, (_, key: string) => entities[key]!);
  };
  const attrs = new Map<string, string>();
  for (const attr of match[1]!.matchAll(/\s+([a-z-]+)="([^"<>]*)"/g)) {
    const value = decode(attr[2]!);
    if (value === null || attrs.has(attr[1]!)) return raw;
    attrs.set(attr[1]!, value);
  }
  const text = decode(match[2]!);
  const kind = attrs.get('kind');
  if (attrs.get('version') !== '1' || !attrs.get('message-id') || text === null) return raw;
  if (kind === 'user-message') {
    if (attrs.has('source-agent-id') || attrs.has('event')) return raw;
  } else if (kind === 'agent-message' || kind === 'agent-notification') {
    if (!attrs.get('source-agent-id')) return raw;
  } else return raw;
  if (attrs.get('message-id') !== clientMessageId) throw new Error('Message envelope identity does not match the prompt');
  if (kind === 'agent-notification') throw new Error('Agent notifications do not send web messages');
  return text;
}
