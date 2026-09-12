import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";

/**
 * - `memo` — a memo body on the timeline and in its history
 * - `document` — a document body: looser leading and real headings
 */
export type MarkdownVariant = "memo" | "document";

export type MarkdownProps = Readonly<{
  body: string;
  variant: MarkdownVariant;
}>;

// A hast node, as much of it as this module reads.
type Tree = {
  type: string;
  tagName?: string;
  value?: string;
  properties?: Record<string, unknown>;
  children?: Tree[];
};

const DASH_MARKER = "dataDashMarker";

// Items of an unordered list get the dash marker; items of an ordered list
// keep their numbers. An item cannot see its parent from `components`, so the
// tree is marked before it is drawn.
const markUnorderedItems = () => (tree: Tree) => {
  const visit = (node: Tree) => {
    for (const child of node.children ?? []) {
      if (node.tagName === "ul" && child.tagName === "li") {
        const className = child.properties?.className;
        const isTask =
          Array.isArray(className) && className.includes("task-list-item");
        if (!isTask)
          child.properties = { ...child.properties, [DASH_MARKER]: true };
      }
      visit(child);
    }
  };
  visit(tree);
};

const treeOf = (node: Tree | undefined): Tree | undefined => node;

const textOf = (node: Tree | undefined): string =>
  node === undefined
    ? ""
    : node.type === "text"
      ? (node.value ?? "")
      : (node.children ?? []).map(textOf).join("");

type Typesetting = Readonly<{
  root: string;
  paragraph: string;
  majorHeading: string;
  minorHeading: string;
  list: string;
  orderedList: string;
  block: string;
}>;

// Each element carries its own space above it (`not-first:`), never below —
// except a document heading, whose `em` space below is the one tokens.md
// allows to stay (「余白の向き」の例外). `em` resolves against the element
// that holds the margin, which is why these stay in `em`.
const TYPESETTING = {
  memo: {
    root: "font-base text-base leading-normal text-neutral-900 wrap-anywhere",
    paragraph: "whitespace-pre-wrap not-first:mt-[1.4em]",
    majorHeading: "font-semibold not-first:mt-[1.4em]",
    minorHeading: "font-semibold not-first:mt-[1.4em]",
    list: "not-first:mt-[0.8em]",
    orderedList: "list-decimal pl-lg not-first:mt-[0.8em]",
    block: "not-first:mt-[1.4em]",
  },
  document: {
    root: "font-base text-base leading-loose text-neutral-900 wrap-anywhere",
    paragraph: "whitespace-pre-wrap not-first:mt-[1.3em]",
    majorHeading:
      "mb-[0.9em] text-lg font-bold leading-tight not-first:mt-[2.2em]",
    minorHeading:
      "mb-[0.9em] text-base font-bold leading-tight not-first:mt-[2.2em]",
    list: "ml-[0.2em] not-first:mt-[0.8em]",
    orderedList: "ml-[0.2em] list-decimal pl-lg not-first:mt-[0.8em]",
    block: "not-first:mt-[1.3em]",
  },
} as const satisfies Record<MarkdownVariant, Typesetting>;

const DASH_ITEM =
  "relative pl-md before:absolute before:left-[0] before:text-neutral-400 before:content-['–']";
const LINK =
  "text-primary-dark underline transition-colors hover:text-primary-darker focus-visible:rounded-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus";
const INLINE_CODE = "rounded-sm bg-neutral-100 px-xs";
const CODE_BLOCK =
  "overflow-x-auto whitespace-pre rounded-sm bg-neutral-50 px-md py-sm text-sm leading-normal";
const QUOTE = "border-l border-neutral-300 pl-md text-neutral-700";
const CELL = "border border-neutral-100 px-sm py-xs text-left";

const componentsFor = (t: Typesetting): Components => ({
  p: ({ children }) => <p className={t.paragraph}>{children}</p>,
  h1: ({ children }) => <h1 className={t.majorHeading}>{children}</h1>,
  h2: ({ children }) => <h2 className={t.majorHeading}>{children}</h2>,
  h3: ({ children }) => <h3 className={t.minorHeading}>{children}</h3>,
  h4: ({ children }) => <h4 className={t.minorHeading}>{children}</h4>,
  h5: ({ children }) => <h5 className={t.minorHeading}>{children}</h5>,
  h6: ({ children }) => <h6 className={t.minorHeading}>{children}</h6>,
  ul: ({ children }) => <ul className={t.list}>{children}</ul>,
  ol: ({ children, start }) => (
    <ol start={start} className={t.orderedList}>
      {children}
    </ol>
  ),
  li: ({ children, node }) => (
    <li
      className={
        treeOf(node)?.properties?.[DASH_MARKER] === true ? DASH_ITEM : undefined
      }
    >
      {children}
    </li>
  ),
  a: ({ children, href, title }) => (
    <a href={href} title={title} className={LINK}>
      {children}
    </a>
  ),
  strong: ({ children }) => (
    <strong className="font-semibold">{children}</strong>
  ),
  code: ({ children }) => <code className={INLINE_CODE}>{children}</code>,
  // Drawn from the tree so the block's `<code>` never goes through the inline
  // `code` above and picks up its background.
  pre: ({ node }) => (
    <pre className={`${CODE_BLOCK} ${t.block}`}>
      <code>{textOf(treeOf(node))}</code>
    </pre>
  ),
  blockquote: ({ children }) => (
    <blockquote className={`${QUOTE} ${t.block}`}>{children}</blockquote>
  ),
  hr: () => <hr className={`border-neutral-100 ${t.block}`} />,
  table: ({ children }) => (
    <div className={`overflow-x-auto ${t.block}`}>
      <table className="border-collapse text-sm">{children}</table>
    </div>
  ),
  th: ({ children, style }) => (
    <th style={style} className={`${CELL} font-semibold`}>
      {children}
    </th>
  ),
  td: ({ children, style }) => (
    <td style={style} className={CELL}>
      {children}
    </td>
  ),
});

const COMPONENTS = {
  memo: componentsFor(TYPESETTING.memo),
  document: componentsFor(TYPESETTING.document),
} as const satisfies Record<MarkdownVariant, Components>;

const REMARK = [remarkGfm];
const REHYPE = [markUnorderedItems];

/**
 * The light Markdown rendering of a memo or document body: paragraphs,
 * headings, lists, emphasis, code, quotes, tables and links, each element
 * set by its own utilities — the typesetting is a table from element to
 * classes, not descendant rules, and `variant` picks the table.
 *
 * Raw HTML in the source is never parsed (no rehype-raw): a tag stays visible
 * as escaped text, so nothing is ever injected and nothing the author typed
 * disappears.
 */
export function Markdown({ body, variant }: MarkdownProps) {
  return (
    <div className={TYPESETTING[variant].root}>
      <ReactMarkdown
        remarkPlugins={REMARK}
        rehypePlugins={REHYPE}
        components={COMPONENTS[variant]}
      >
        {body}
      </ReactMarkdown>
    </div>
  );
}
