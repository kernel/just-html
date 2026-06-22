"use client";

import { memo, useId, type ReactNode } from "react";
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
//
// clobber is emptied because the only id/name attributes in the output are the
// footnote ids remark-rehype generates (raw HTML is off, so authors can't inject
// ids); those are namespaced per render below via clobberPrefix instead, which keeps
// each card's footnote refs pointing inside that card.
const schema = {
  ...defaultSchema,
  tagNames: defaultSchema.tagNames?.filter((tag) => tag !== "img"),
  clobber: [],
  attributes: {
    ...defaultSchema.attributes,
    a: [...(defaultSchema.attributes?.a ?? []), "target", "rel"],
  },
};

const components = {
  // data-no-pin: comment bodies render inside a click-to-pin card (see CommentsShell
  // Card onClick); without it, clicking a link would also toggle the thread's pin.
  // Only off-page links open a new tab — in-page (#fragment) links, e.g. footnote
  // back-references, must navigate within the card rather than spawn a tab.
  a: ({ href, children }: { href?: string; children?: ReactNode }) => {
    const inPage = href?.startsWith("#") ?? false;
    return (
      <a href={href} data-no-pin {...(inPage ? {} : { target: "_blank", rel: "noopener noreferrer" })}>
        {children}
      </a>
    );
  },
};

function CommentMarkdown({ body }: { body: string }) {
  // Namespace footnote ids per comment so multiple cards in one shell DOM don't
  // collide — a footnote ref must scroll to its own card's note, not another's.
  const prefix = useId().replace(/:/g, "") + "-";
  return (
    <div className="jh-md">
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkBreaks]}
        remarkRehypeOptions={{ clobberPrefix: prefix }}
        rehypePlugins={[[rehypeSanitize, schema]]}
        components={components}
      >
        {body}
      </ReactMarkdown>
    </div>
  );
}

export default memo(CommentMarkdown);
