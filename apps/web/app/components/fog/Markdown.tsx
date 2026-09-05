import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

export function Markdown({
  body,
  compact = false,
}: {
  body: string;
  compact?: boolean;
}) {
  return (
    <div className={`fog-markdown${compact ? " fog-markdown-compact" : ""}`}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ node: _node, ...props }) => (
            <a {...props} rel="noreferrer noopener" />
          ),
          img: ({ alt }) => (
            <span className="fog-image-alt">
              {alt ? `[画像: ${alt}]` : "[画像]"}
            </span>
          ),
        }}
      >
        {body}
      </ReactMarkdown>
    </div>
  );
}
