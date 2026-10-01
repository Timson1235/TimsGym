import React from 'react';
import ReactMarkdown, { Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';

interface ChatMarkdownProps {
  content: string;
  variant?: 'light' | 'dark' | 'user';
}

export const ChatMarkdown: React.FC<ChatMarkdownProps> = ({
  content,
  variant = 'light',
}) => {
  const isDark = variant === 'dark';
  const isUser = variant === 'user';
  const accentClass = isDark
    ? 'text-lime-300'
    : isUser
      ? 'text-white underline decoration-white/60'
      : 'text-teal-700';

  const components: Components = {
    p: ({ children }) => <p className="mb-2 last:mb-0">{children}</p>,
    strong: ({ children }) => <strong className="font-bold">{children}</strong>,
    em: ({ children }) => <em className="italic">{children}</em>,
    ul: ({ children }) => <ul className="my-2 list-disc space-y-1 pl-5">{children}</ul>,
    ol: ({ children }) => <ol className="my-2 list-decimal space-y-1 pl-5">{children}</ol>,
    li: ({ children }) => <li className="pl-0.5">{children}</li>,
    a: ({ children, href }) => (
      <a
        href={href}
        target="_blank"
        rel="noreferrer noopener"
        className={`${accentClass} font-semibold underline underline-offset-2`}
      >
        {children}
      </a>
    ),
    blockquote: ({ children }) => (
      <blockquote
        className={`my-2 border-l-2 pl-3 ${
          isDark ? 'border-lime-400/50 text-slate-300' : isUser ? 'border-white/50' : 'border-teal-300 text-slate-600'
        }`}
      >
        {children}
      </blockquote>
    ),
    code: ({ children }) => (
      <code
        className={`rounded px-1 py-0.5 font-mono text-[0.92em] ${
          isDark ? 'bg-slate-800 text-lime-300' : isUser ? 'bg-teal-900/30 text-white' : 'bg-slate-100 text-slate-800'
        }`}
      >
        {children}
      </code>
    ),
    pre: ({ children }) => (
      <pre
        className={`my-2 max-w-full overflow-x-auto rounded-lg p-3 ${
          isDark ? 'bg-slate-950' : isUser ? 'bg-teal-900/30' : 'bg-slate-100'
        }`}
      >
        {children}
      </pre>
    ),
  };

  return (
    <div className="min-w-0 break-words">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {content}
      </ReactMarkdown>
    </div>
  );
};
