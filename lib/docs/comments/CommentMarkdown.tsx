"use client";

import { memo, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkBreaks from "remark-breaks";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";

// Comment bodies are untrusted — any human grantee or agent can post them — and the
// rail renders in the justhtml.sh shell origin (cookies/session), not the sandboxed
// doc iframe, so this is a stored-XSS surface. react-markdown v10 is safe by default
// (raw HTML is inert, dangerous URL protocols are dropped); rehype-sanitize is
// defense-in-depth, so turning raw HTML on later can never escalate a comment into
// account takeover. Images are stripped: a remote <img> in a session origin is a
// tracking / CSRF-pixel vector with no value in a review thread.
const schema = {
  ...defaultSchema,
  tagNames: defaultSchema.tagNames?.filter((tag) => tag !== "img"),
  attributes: {
    ...defaultSchema.attributes,
    a: [...(defaultSchema.attributes?.a ?? []), "target", "rel"],
  },
};

const components = {
  // data-no-pin: comment bodies render inside a click-to-pin card (see CommentsShell
  // Card onClick); without it, clicking a link would also toggle the thread's pin.
  a: ({ href, children }: { href?: string; children?: ReactNode }) => (
    <a href={href} target="_blank" rel="noopener noreferrer" data-no-pin>
      {children}
    </a>
  ),
};

function CommentMarkdown({ body }: { body: string }) {
  return (
    <div className="jh-md">
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkBreaks]}
        rehypePlugins={[[rehypeSanitize, schema]]}
        components={components}
      >
        {body}
      </ReactMarkdown>
    </div>
  );
}

export default memo(CommentMarkdown);
