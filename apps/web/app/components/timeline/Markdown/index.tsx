import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

/**
 * The light Markdown rendering of a memo body: lists, emphasis, code and
 * links, drawn as React elements — raw HTML in the source is shown as text.
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
