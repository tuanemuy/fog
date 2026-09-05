import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Markdown } from "./Markdown";

describe("safe content rendering", () => {
  it("renders lists and code while escaping executable content and unsafe links", () => {
    const html = renderToStaticMarkup(
      <Markdown
        body={
          '# 見出し\n\n- リスト\n- 二つ目\n\n```js\nalert("example")\n```\n\n<script>alert("bad")</script>\n\n[危険](javascript:alert%281%29)\n\n![外部画像](https://tracker.invalid/pixel)'
        }
      />,
    );
    expect(html).toContain("<h1>見出し</h1>");
    expect(html).toContain("<li>リスト</li>");
    expect(html).toContain("<pre><code");
    expect(html).not.toContain("<script");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("bad");
    expect(html).not.toContain("javascript:");
    expect(html).not.toContain("<img");
    expect(html).not.toContain("tracker.invalid");
    expect(html).toContain("[画像: 外部画像]");
  });
});
