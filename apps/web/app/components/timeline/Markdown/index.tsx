import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

/**
 * The light Markdown rendering of a memo body: lists, emphasis, code and
 * links, drawn as React elements. Raw HTML in the source is never parsed
 * (no rehype-raw): a tag stays visible as escaped text, so nothing is ever
 * injected and nothing the author typed disappears.
 */
export function Markdown({ body }: { body: string }) {
  return (
    <div className="fog-markdown">
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{body}</ReactMarkdown>
    </div>
  );
}
