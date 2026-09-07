import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

/**
 * The light Markdown rendering of a memo body: lists, emphasis, code and
 * links, drawn as React elements. Raw HTML in the source is skipped — a tag
 * is dropped and only its inner text survives — so nothing is ever injected.
 */
export function Markdown({ body }: { body: string }) {
  return (
    <div className="fog-markdown">
      <ReactMarkdown remarkPlugins={[remarkGfm]} skipHtml>
        {body}
      </ReactMarkdown>
    </div>
  );
}
