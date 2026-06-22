"use client";

import { memo, useId, type ComponentPropsWithoutRef } from "react";
import ReactMarkdown, { type ExtraProps } from "react-markdown";
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
  // back-references, must navigate within the card rather than spawn a tab. The rest
  // of the sanitized attributes (id, aria-*, data-footnote-*) are forwarded so
  // footnote ref/backref anchors keep the ids their return links target.
  a: ({ node, href, children, ...rest }: ComponentPropsWithoutRef<"a"> & ExtraProps) => {
    const inPage = href?.startsWith("#") ?? false;
    return (
      <a {...rest} href={href} data-no-pin {...(inPage ? {} : { target: "_blank", rel: "noopener noreferrer" })}>
        {children}
      </a>
    );
  },
};

function CommentMarkdown({ body }: { body: string }) {
  // Namespace footnote ids per comment so multiple cards in one shell DOM don't
  // collide — a footnote ref must scroll to its own card's note, not another's. The
  // id is stripped to ASCII (React 19's useId returns non-alphanumeric delimiters).
  const prefix = useId().replace(/[^a-zA-Z0-9]/g, "") + "-";
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
