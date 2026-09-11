import { Button } from "@/components/ui/Button";
import { Row } from "@/components/ui/Row";
import { RowList } from "@/components/ui/RowList";
import { Sk } from "@/components/ui/Sk";
import {
  ItemDescription,
  ItemMeta,
  ItemName,
  SettingsSection,
} from "../SettingsSection";

/**
 * `CurrentUserPanel` before it streams in (ADR-005 of Issue #22): the same
 * sections, rows and buttons, with the data's text laid over by `Sk` and
 * every control disabled. The section labels are the real ones — they do not
 * depend on the data. One polite status names the region; everything under
 * it is hidden from assistive technology.
 */
export function SettingsSkeleton() {
  return (
    <div role="status" aria-live="polite" aria-busy="true">
      <span className="sr-only">読み込み中</span>
      <div aria-hidden="true">
        <SettingsSection id="settings-ai-loading" label="AI">
          <RowList>
            {["Claude Desktop", "Cursor"].map((name) => (
              <li key={name}>
                <Row
                  actions={
                    <Button variant="danger-text" disabled>
                      <Sk>接続を解除</Sk>
                    </Button>
                  }
                >
                  <ItemName>
                    <Sk>{name}</Sk>
                  </ItemName>
                  <ItemMeta>
                    <Sk>接続: 2025年12月15日</Sk>
                    <br />
                    <Sk>最終利用: 2026年9月10日 14:30</Sk>
                  </ItemMeta>
                </Row>
              </li>
            ))}
          </RowList>
        </SettingsSection>
        <SettingsSection id="settings-credentials-loading" label="ログイン手段">
          <RowList>
            <li>
              <Row>
                <ItemName>
                  <Sk>you@example.com</Sk>
                </ItemName>
                <ItemMeta>
                  <Sk>メール・パスワード</Sk>
                </ItemMeta>
              </Row>
            </li>
          </RowList>
        </SettingsSection>
        <SettingsSection id="settings-trash-loading" label="ゴミ箱">
          <Row
            actions={
              <Button variant="fill-sm" disabled>
                <Sk>保存</Sk>
              </Button>
            }
          >
            <ItemName>
              <Sk>保持期限</Sk>
            </ItemName>
            <ItemDescription>
              <Sk>既存のゴミ箱の項目にも適用されます</Sk>
            </ItemDescription>
          </Row>
        </SettingsSection>
        <SettingsSection id="settings-data-loading" label="データ">
          <Row
            actions={
              <Button variant="fill-sm" disabled>
                <Sk>エクスポート</Sk>
              </Button>
            }
          >
            <ItemName>
              <Sk>エクスポート</Sk>
            </ItemName>
            <ItemDescription>
              <Sk>Markdown形式。ゴミ箱・履歴は含まれません</Sk>
            </ItemDescription>
          </Row>
        </SettingsSection>
        <SettingsSection id="settings-account-loading" label="アカウント">
          <Button variant="text" disabled>
            <Sk>ログアウト</Sk>
          </Button>
        </SettingsSection>
      </div>
    </div>
  );
}
