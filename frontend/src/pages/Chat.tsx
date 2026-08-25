import { useEffect, useRef, useState, useCallback } from 'react';
import { fetchAuthSession } from 'aws-amplify/auth';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { getConfig } from '../config';
import {
  getStoredMessages,
  setStoredMessages,
  type Citation,
  type ChatMessage,
} from './chatStore';

// --- Citation chip ---

function CitationChip({ citation }: { citation: Citation }) {
  const pct = Math.round(citation.confidence * 100);
  const bgColor =
    pct >= 90
      ? 'var(--accent-success)'
      : pct >= 70
        ? 'var(--accent-warning)'
        : 'var(--accent-danger)';

  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: '0.25rem',
        margin: '0.125rem',
        padding: '0.125rem 0.5rem',
        borderRadius: '12px',
        fontSize: '0.75rem',
        fontWeight: 500,
        border: `1px solid ${bgColor}`,
        color: bgColor,
        background: `color-mix(in srgb, ${bgColor} 12%, transparent)`,
        fontFamily: 'var(--font-mono)',
      }}
      title={`Gene: ${citation.gene} | Tool: ${citation.tool} | Confidence: ${pct}%`}
      aria-label={`Citation: gene ${citation.gene}, tool ${citation.tool}, ${pct}% confidence`}
    >
      <span>{citation.gene}</span>
      <span
        style={{
          fontSize: '0.6875rem',
          opacity: 0.75,
          fontFamily: 'var(--font-sans)',
        }}
      >
        {citation.tool}
      </span>
      <span
        style={{
          fontSize: '0.6875rem',
          background: `color-mix(in srgb, ${bgColor} 25%, transparent)`,
          borderRadius: '8px',
          padding: '0 0.25rem',
        }}
      >
        {pct}%
      </span>
    </span>
  );
}

// --- Message bubble ---

function MessageBubble({ message }: { message: ChatMessage }) {
  const isUser = message.role === 'user';
  return (
    <div
      style={{
        display: 'flex',
        justifyContent: isUser ? 'flex-end' : 'flex-start',
        marginBottom: '1rem',
      }}
    >
      {!isUser && (
        <div
          aria-hidden="true"
          style={{
            width: '32px',
            height: '32px',
            borderRadius: '50%',
            background: 'var(--accent-primary)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: '0.875rem',
            marginRight: '0.75rem',
            flexShrink: 0,
            color: '#fff',
            fontWeight: 700,
          }}
        >
          A
        </div>
      )}
      <div style={{ maxWidth: '70%' }}>
        <div
          style={{
            padding: '0.75rem 1rem',
            borderRadius: isUser ? '16px 16px 4px 16px' : '16px 16px 16px 4px',
            background: isUser ? 'var(--accent-primary)' : 'var(--bg-card)',
            border: isUser ? 'none' : '1px solid var(--border-color)',
            color: isUser ? '#fff' : 'var(--text-primary)',
            fontSize: '0.9375rem',
            lineHeight: 1.6,
            wordBreak: 'break-word',
          }}
          aria-label={`${isUser ? 'Your' : 'Assistant'} message`}
        >
          {isUser ? (
            message.content
          ) : (
            <div className="chat-markdown">
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{message.content}</ReactMarkdown>
            </div>
          )}
          {message.isStreaming && (
            <span
              aria-hidden="true"
              style={{
                display: 'inline-block',
                width: '8px',
                height: '14px',
                background: isUser ? '#fff' : 'var(--accent-primary)',
                marginLeft: '2px',
                animation: 'blink 1s step-end infinite',
                verticalAlign: 'text-bottom',
                borderRadius: '1px',
              }}
            />
          )}
        </div>
        {message.citations && message.citations.length > 0 && (
          <div
            style={{ marginTop: '0.375rem' }}
            role="list"
            aria-label="Citations"
          >
            {message.citations.map((c, i) => (
              <span key={i} role="listitem">
                <CitationChip citation={c} />
              </span>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// --- Main Chat component ---

type WsStatus = 'connecting' | 'connected' | 'disconnected' | 'error';

// A conversation session id must be >= 33 chars for AgentCore (the bridge pads
// short ids, but generating a long one here keeps the same id across a
// conversation so the agent can maintain context).
function newSessionId(): string {
  return `sess-${Date.now()}-${crypto.randomUUID()}`;
}

export function Chat() {
  const [messages, setMessages] = useState<ChatMessage[]>(() => getStoredMessages());
  const [input, setInput] = useState('');
  const sessionIdRef = useRef<string>(newSessionId());

  // Persist messages at module scope so navigating away and back keeps the chat.
  useEffect(() => {
    setStoredMessages(messages);
  }, [messages]);
  const [wsStatus, setWsStatus] = useState<WsStatus>('disconnected');
  const wsRef = useRef<WebSocket | null>(null);
  const messagesEndRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  useEffect(() => {
    scrollToBottom();
  }, [messages]);

  const connect = useCallback(async () => {
    if (wsRef.current?.readyState === WebSocket.OPEN) return;

    setWsStatus('connecting');
    try {
      const { tokens } = await fetchAuthSession();
      const token = tokens?.idToken?.toString() ?? '';

      const url = `${getConfig().wsApiUrl}?token=${encodeURIComponent(token)}`;
      const ws = new WebSocket(url);
      wsRef.current = ws;

      ws.onopen = () => {
        setWsStatus('connected');
      };

      ws.onmessage = (event: MessageEvent) => {
        try {
          const data = JSON.parse(event.data as string) as {
            type?: string;
            content?: string;
            token?: string;
            citations?: Citation[];
            done?: boolean;
            error?: string;
          };

          // The server sends the answer in `content` (single frame) or `token`
          // (streamed). Accept either so the UI is robust to both shapes.
          const chunk = data.content ?? data.token;
          if (data.type === 'token' && chunk !== undefined) {
            // Append streaming token
            setMessages((prev) => {
              const last = prev[prev.length - 1];
              if (last && last.role === 'assistant' && last.isStreaming) {
                return [
                  ...prev.slice(0, -1),
                  { ...last, content: last.content + chunk },
                ];
              }
              // New streaming message
              return [
                ...prev,
                {
                  id: `stream-${Date.now()}`,
                  role: 'assistant',
                  content: chunk,
                  isStreaming: true,
                },
              ];
            });
          } else if (data.type === 'citations' && data.citations) {
            // Attach citations to last assistant message
            setMessages((prev) => {
              const last = prev[prev.length - 1];
              if (last && last.role === 'assistant') {
                return [
                  ...prev.slice(0, -1),
                  { ...last, citations: data.citations },
                ];
              }
              return prev;
            });
          } else if (data.type === 'done' || data.done) {
            // Mark streaming complete
            setMessages((prev) => {
              const last = prev[prev.length - 1];
              if (last && last.isStreaming) {
                return [...prev.slice(0, -1), { ...last, isStreaming: false }];
              }
              return prev;
            });
          } else if (data.type === 'error' || data.error) {
            const detail = data.error ?? data.content ?? 'Unknown error from server';
            setMessages((prev) => {
              // Replace an in-progress streaming bubble with the error, else append.
              const last = prev[prev.length - 1];
              const errorMsg: ChatMessage = {
                id: `err-${Date.now()}`,
                role: 'assistant',
                content: `Error: ${detail}`,
              };
              if (last && last.role === 'assistant' && last.isStreaming) {
                return [...prev.slice(0, -1), errorMsg];
              }
              return [...prev, errorMsg];
            });
          }
        } catch {
          // Raw text token (non-JSON streaming)
          const text = event.data as string;
          setMessages((prev) => {
            const last = prev[prev.length - 1];
            if (last && last.role === 'assistant' && last.isStreaming) {
              return [...prev.slice(0, -1), { ...last, content: last.content + text }];
            }
            return [
              ...prev,
              {
                id: `stream-${Date.now()}`,
                role: 'assistant',
                content: text,
                isStreaming: true,
              },
            ];
          });
        }
      };

      ws.onerror = () => {
        setWsStatus('error');
      };

      ws.onclose = () => {
        setWsStatus('disconnected');
        wsRef.current = null;
        // Auto-reconnect after 3s
        reconnectTimerRef.current = setTimeout(() => {
          void connect();
        }, 3000);
      };
    } catch {
      setWsStatus('error');
    }
  }, []);

  useEffect(() => {
    void connect();
    return () => {
      if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
      wsRef.current?.close();
    };
  }, [connect]);

  const sendMessage = useCallback(() => {
    const text = input.trim();
    if (!text) return;
    if (wsRef.current?.readyState !== WebSocket.OPEN) {
      void connect();
      return;
    }

    // Add user message
    setMessages((prev) => [
      ...prev,
      { id: `user-${Date.now()}`, role: 'user', content: text },
    ]);
    setInput('');

    // Send over WebSocket, including the conversation session id so the agent
    // keeps context within a conversation.
    wsRef.current.send(JSON.stringify({ action: 'message', message: text, sessionId: sessionIdRef.current }));
  }, [input, connect]);

  // Starting a new conversation rotates the AgentCore session id. The bridge
  // passes this id as the runtimeSessionId, so a fresh id gives the agent a
  // clean context server-side (no memory of the prior exchange) and clears the
  // locally stored transcript.
  const startNewConversation = useCallback(() => {
    if (messages.length > 0) {
      const ok = window.confirm(
        'Start a new conversation? This clears the current transcript and resets the agent context.',
      );
      if (!ok) return;
    }
    sessionIdRef.current = newSessionId();
    setMessages([]);
    setStoredMessages([]);
    inputRef.current?.focus();
  }, [messages.length]);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  };

  const statusColor: Record<WsStatus, string> = {
    connecting: 'var(--accent-warning)',
    connected: 'var(--accent-success)',
    disconnected: 'var(--text-secondary)',
    error: 'var(--accent-danger)',
  };

  const statusLabel: Record<WsStatus, string> = {
    connecting: 'Connecting...',
    connected: 'Connected',
    disconnected: 'Disconnected',
    error: 'Connection error',
  };

  const isSending = wsStatus === 'connected';

  return (
    <>
      <style>{`
        @keyframes blink {
          50% { opacity: 0; }
        }
      `}</style>
      <div
        className="page-container"
        style={{ display: 'flex', flexDirection: 'column', height: 'calc(100vh - 72px)', paddingBottom: '1rem' }}
      >
        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '1rem' }}>
          <h1 style={{ marginBottom: 0 }}>Chat.</h1>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
            <button
              type="button"
              onClick={startNewConversation}
              disabled={messages.length === 0}
              aria-label="Start a new conversation and clear the current transcript"
              title="Clears the transcript and resets the agent context"
              style={{
                padding: '0.375rem 0.75rem',
                fontSize: '0.75rem',
                background: 'var(--bg-card)',
                border: '1px solid var(--border-color)',
                borderRadius: '4px',
                color: 'var(--text-primary)',
              }}
            >
              New conversation
            </button>
          <div
            style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', fontSize: '0.8125rem' }}
            role="status"
            aria-live="polite"
            aria-label={`WebSocket status: ${statusLabel[wsStatus]}`}
          >
            <span
              aria-hidden="true"
              style={{
                width: '8px',
                height: '8px',
                borderRadius: '50%',
                background: statusColor[wsStatus],
                display: 'inline-block',
              }}
            />
            <span style={{ color: statusColor[wsStatus] }}>{statusLabel[wsStatus]}</span>
            {wsStatus === 'disconnected' || wsStatus === 'error' ? (
              <button
                type="button"
                onClick={() => void connect()}
                aria-label="Reconnect to chat"
                style={{
                  padding: '0.25rem 0.625rem',
                  fontSize: '0.75rem',
                  background: 'var(--bg-card)',
                  border: '1px solid var(--border-color)',
                  borderRadius: '4px',
                  color: 'var(--text-primary)',
                }}
              >
                Reconnect
              </button>
            ) : null}
          </div>
          </div>
        </div>

        {/* Messages area */}
        <div
          id="main-content"
          style={{
            flex: 1,
            overflowY: 'auto',
            background: 'var(--bg-secondary)',
            border: '1px solid var(--border-color)',
            borderRadius: '8px',
            padding: '1rem',
            marginBottom: '1rem',
          }}
          role="log"
          aria-label="Chat messages"
          aria-live="polite"
          aria-atomic="false"
        >
          {messages.length === 0 && (
            <div
              style={{
                height: '100%',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                color: 'var(--text-secondary)',
                fontSize: '0.9375rem',
              }}
            >
              <div style={{ textAlign: 'center' }}>
                <div className="petri-loader" style={{ animationPlayState: 'paused' }} aria-hidden="true" />
                <p>Ask about AMR genes, resistance patterns, or workflow results.</p>
              </div>
            </div>
          )}
          {messages.map((msg) => (
            <MessageBubble key={msg.id} message={msg} />
          ))}
          <div ref={messagesEndRef} aria-hidden="true" />
        </div>

        {/* Input area */}
        <div
          style={{
            display: 'flex',
            gap: '0.75rem',
            alignItems: 'flex-end',
          }}
        >
          <textarea
            ref={inputRef}
            id="chat-input"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Ask about AMR genes, resistance patterns... (Enter to send, Shift+Enter for newline)"
            rows={2}
            aria-label="Chat message input"
            aria-describedby="chat-hint"
            style={{
              flex: 1,
              background: 'var(--bg-card)',
              border: '1px solid var(--border-color)',
              borderRadius: '8px',
              color: 'var(--text-primary)',
              fontFamily: 'var(--font-sans)',
              fontSize: '0.9375rem',
              padding: '0.75rem',
              resize: 'none',
              outline: 'none',
              transition: 'border-color 0.15s ease',
            }}
            onFocus={(e) => { e.currentTarget.style.borderColor = 'var(--accent-primary)'; }}
            onBlur={(e) => { e.currentTarget.style.borderColor = 'var(--border-color)'; }}
          />
          <button
            type="button"
            onClick={sendMessage}
            disabled={!input.trim() || !isSending}
            className="btn-primary"
            aria-label="Send message"
            style={{
              padding: '0.75rem 1.25rem',
              borderRadius: '8px',
              fontSize: '0.9375rem',
              minWidth: '80px',
            }}
          >
            Send
          </button>
        </div>
        <p
          id="chat-hint"
          style={{ marginTop: '0.375rem', fontSize: '0.75rem', color: 'var(--text-secondary)' }}
        >
          Press Enter to send, Shift+Enter for a new line.
        </p>
      </div>
    </>
  );
}
