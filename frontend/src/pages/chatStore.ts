// Module-level chat session store.
//
// React Router unmounts the Chat page on navigation, which would otherwise
// discard the conversation. Keeping the message list at module scope preserves
// it for the lifetime of the browser session (a full reload clears it), so
// switching tabs and coming back does not lose the chat.

export interface Citation {
  gene: string;
  tool: string;
  confidence: number;
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  citations?: Citation[];
  isStreaming?: boolean;
}

let messages: ChatMessage[] = [];

export function getStoredMessages(): ChatMessage[] {
  return messages;
}

export function setStoredMessages(next: ChatMessage[]): void {
  messages = next;
}
