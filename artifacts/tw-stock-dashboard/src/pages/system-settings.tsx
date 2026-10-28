import { useEffect, useState } from "react";
import { useAuth } from "@clerk/react";
import { useQueryClient } from "@tanstack/react-query";
import {
  getGetAccountLineNotificationsQueryKey,
  useDeleteAccountLineLink,
  useGetAccountLineNotifications,
  usePostAccountLineLinkCode,
  usePutAccountLineNotifications,
} from "@workspace/api-client-react";
import { BellRing, Copy, Link2, RotateCcw, Type, Unlink } from "lucide-react";
import {
  applyUiScale,
  DEFAULT_UI_SCALE,
  MAX_UI_SCALE,
  MIN_UI_SCALE,
  readUiScale,
} from "@/lib/ui-scale";
import "./system-settings.css";

function lineSettingsErrorMessage(error: unknown): string {
  if (!error || typeof error !== "object") {
    return "無法載入 LINE 設定，請稍後重試。";
  }
  if ("data" in error && error.data && typeof error.data === "object" && "error" in error.data) {
    const message = error.data.error;
    if (typeof message === "string" && message.trim()) return message;
  }
  if ("status" in error && error.status === 401) return "登入狀態已失效，請重新登入後再載入 LINE 設定。";
  if ("status" in error && error.status === 403) return "此帳戶尚未獲邀使用台股儀表板，無法載入 LINE 設定。";
  return "無法載入 LINE 設定，請稍後重試。";
}

export default function SystemSettingsPage() {
  const [scale, setScale] = useState(readUiScale);
  const { isLoaded, isSignedIn, userId } = useAuth();
  const queryClient = useQueryClient();
  const lineSettingsQueryKey = [
    ...getGetAccountLineNotificationsQueryKey(),
    userId ?? "signed-out",
  ] as const;
  const settingsQuery = useGetAccountLineNotifications({
    query: {
      queryKey: lineSettingsQueryKey,
      enabled: isLoaded && isSignedIn === true,
    },
    request: { credentials: "include" },
  });
  const saveSettings = usePutAccountLineNotifications({ request: { credentials: "include" } });
  const createLinkCode = usePostAccountLineLinkCode({ request: { credentials: "include" } });
  const unlinkLine = useDeleteAccountLineLink({ request: { credentials: "include" } });
  const [closingSummary, setClosingSummary] = useState(false);
  const [premarketSummary, setPremarketSummary] = useState(false);
  const [quantSignalAlerts, setQuantSignalAlerts] = useState(false);
  const [linkCode, setLinkCode] = useState("");
  const [statusMessage, setStatusMessage] = useState("");

  useEffect(() => {
    if (!settingsQuery.data) return;
    setClosingSummary(settingsQuery.data.closingSummary);
    setPremarketSummary(settingsQuery.data.premarketSummary);
    setQuantSignalAlerts(settingsQuery.data.quantSignalAlerts);
  }, [settingsQuery.data]);

  const persistSettings = () => {
    saveSettings.mutate({ data: {
      alerts: settingsQuery.data?.alerts ?? [],
      openingNotice: settingsQuery.data?.openingNotice ?? false,
      closingSummary,
      premarketSummary,
      quantSignalAlerts,
    } }, {
      onSuccess: () => {
        setStatusMessage("LINE 通知設定已儲存。");
        void queryClient.invalidateQueries({ queryKey: lineSettingsQueryKey });
      },
      onError: () => setStatusMessage("儲存失敗，請稍後重試。"),
    });
  };

  const updateScale = (value: string) => {
    setScale(applyUiScale(Number(value)));
  };

  const resetScale = () => {
    setScale(applyUiScale(DEFAULT_UI_SCALE));
  };

  return (
    <main className="dashboard-main route-page system-settings-page" data-testid="page-system-settings">
      <div className="route-page-heading">
        <div>
          <p className="section-eyebrow">PREFERENCES / 05</p>
          <h1>系統設定</h1>
          <p className="lede">調整整個研究台的文字顯示大小。</p>
        </div>
      </div>

      <section className="glass-panel system-settings-card" aria-labelledby="system-settings-font-title">
        <div className="system-settings-card-header">
          <div className="system-settings-icon" aria-hidden="true">
            <Type size={19} />
          </div>
          <div className="system-settings-card-copy">
            <p className="system-settings-eyebrow">DISPLAY / 01</p>
            <h2 id="system-settings-font-title">全域字級</h2>
            <p>即時調整市場分析、量化研究與帳戶頁面的顯示比例。</p>
          </div>
          <output className="system-settings-scale" htmlFor="system-settings-scale-input" aria-live="polite">
            {scale}%
          </output>
        </div>

        <div className="system-settings-control">
          <div className="system-settings-control-heading">
            <label htmlFor="system-settings-scale-input">介面字級</label>
            <span>{scale}%</span>
          </div>
          <input
            id="system-settings-scale-input"
            className="system-settings-slider"
            type="range"
            min={MIN_UI_SCALE}
            max={MAX_UI_SCALE}
            step="5"
            value={scale}
            onChange={(event) => updateScale(event.target.value)}
            aria-valuetext={`${scale}%`}
            aria-describedby="system-settings-scale-help"
            data-testid="input-system-font-scale"
          />
          <div className="system-settings-range-labels" aria-hidden="true">
            <span>較小　{MIN_UI_SCALE}%</span>
            <span>預設　{DEFAULT_UI_SCALE}%</span>
            <span>較大　{MAX_UI_SCALE}%</span>
          </div>
        </div>

        <div className="system-settings-preview" data-testid="preview-system-font-scale">
          <span className="system-settings-eyebrow">PREVIEW / 預覽</span>
          <h3>讓重要資訊更容易閱讀</h3>
          <p>
            文字調整會立即套用到所有頁面，版面會依視窗寬度重新排列，內容可正常捲動。
          </p>
          <span className="system-settings-preview-chip">字級 {scale}%</span>
        </div>

        <div className="system-settings-footer">
          <p id="system-settings-scale-help">
            字級偏好只保存在此瀏覽器。放大時介面比例同步調整，不使用浮動視窗或遮罩，不會蓋住其他內容。
          </p>
          <button
            type="button"
            className="system-settings-reset"
            onClick={resetScale}
            disabled={scale === DEFAULT_UI_SCALE}
            data-testid="button-reset-system-font-scale"
          >
            <RotateCcw size={14} />
            重設為標準字級
          </button>
        </div>
      </section>

      <section className="glass-panel system-settings-card line-settings-card" aria-labelledby="line-settings-title" data-testid="panel-line-notifications">
        <div className="system-settings-card-header">
          <div className="system-settings-icon" aria-hidden="true"><BellRing size={19} /></div>
          <div className="system-settings-card-copy">
            <p className="system-settings-eyebrow">MESSAGING / LINE</p>
            <h2 id="line-settings-title">LINE 通知設定</h2>
            <p>設定個人收盤摘要與量化掃描推播；所有內容只傳送給已連結的 LINE 帳號。加入官方帳號後，也可直接傳一般訊息與 AI 助手聊天；傳送「清除對話」可刪除 LINE 聊天脈絡。</p>
          </div>
          <span className={`line-link-state ${settingsQuery.data?.linked ? "is-linked" : ""}`} data-testid="status-line-link">
            {settingsQuery.data?.linked ? "已連結" : "未連結"}
          </span>
        </div>

        {!isLoaded || settingsQuery.isLoading ? <p role="status">正在載入 LINE 通知設定…</p> :
          !isSignedIn ? <p className="line-settings-note">請先登入，才能設定個人 LINE 通知。</p> :
          settingsQuery.isError ? <p role="alert">{lineSettingsErrorMessage(settingsQuery.error)}</p> : <>
            <div className="line-link-actions">
              {settingsQuery.data?.linked ? (
                <button
                  type="button" className="system-settings-reset"
                  onClick={() => unlinkLine.mutate(undefined, {
                    onSuccess: () => {
                      setLinkCode("");
                      setStatusMessage("LINE 帳號已解除連結。");
                      void queryClient.invalidateQueries({ queryKey: lineSettingsQueryKey });
                    },
                  })}
                  disabled={unlinkLine.isPending} data-testid="button-unlink-line"
                ><Unlink size={15} />解除連結</button>
              ) : (
                <button
                  type="button" className="system-settings-reset line-primary-action"
                  onClick={() => {
                    setLinkCode("");
                    setStatusMessage("");
                    createLinkCode.mutate(undefined, {
                      onSuccess: (result) => {
                        setLinkCode(result.code);
                        setStatusMessage("");
                      },
                      onError: () => {
                        setStatusMessage("連結碼產生失敗；請確認登入狀態後重試。");
                      },
                    });
                  }}
                  disabled={createLinkCode.isPending} data-testid="button-create-line-link-code"
                ><Link2 size={15} />{createLinkCode.isPending ? "產生中…" : "產生連結碼"}</button>
              )}
              {linkCode && <div className="line-link-code" role="status" data-testid="text-line-link-code">
                <strong>10 分鐘內有效</strong>
                <button
                  type="button"
                  className="system-settings-reset"
                  onClick={async () => {
                    try {
                      await navigator.clipboard.writeText(`LINK ${linkCode}`);
                      setStatusMessage("已複製完整指令，請到 LINE 官方帳號聊天室貼上傳送。");
                    } catch {
                      setStatusMessage("無法自動複製；請長按下方連結碼手動複製。");
                    }
                  }}
                  data-testid="button-copy-line-link-command"
                ><Copy size={15} />複製 LINE 指令</button>
                <code>{linkCode}</code>
                <p>先加入你的 LINE 官方帳號，再傳送 <code>LINK {linkCode}</code> 完成綁定。連結碼只能使用一次。</p>
              </div>}
            </div>

            <div className="line-report-options">
              <label>
                <input
                  type="checkbox"
                  checked={premarketSummary}
                  onChange={(event) => setPremarketSummary(event.target.checked)}
                  data-testid="input-line-premarket-summary"
                />
                平日早上 8:30 接收 AI 盤前摘要
              </label>
              <label>
                <input
                  type="checkbox"
                  checked={closingSummary}
                  onChange={(event) => setClosingSummary(event.target.checked)}
                  data-testid="input-line-closing-summary"
                />
                每個台股交易日接收收盤摘要
              </label>
              <label>
                <input
                  type="checkbox"
                  checked={quantSignalAlerts}
                  onChange={(event) => setQuantSignalAlerts(event.target.checked)}
                  data-testid="input-line-quant-signals"
                />
                每個台股交易日 10:30 與 17:00 接收量化掃描（僅推播符合條件的自選股）
              </label>
            </div>

            <div className="system-settings-footer">
              <p className="line-settings-note">盤前摘要於台灣時間 8:30 傳送，收盤摘要於收盤資料到齊後傳送。量化掃描於每個台股交易日 10:30 與 17:00 執行，只推播符合條件的自選股；資料日期或來源未通過檢查時不傳送。</p>
              {!settingsQuery.data?.linked && (
                <p className="line-settings-note">請先產生連結碼並完成 LINE 綁定，才能儲存摘要設定。</p>
              )}
              <button type="button" className="system-settings-reset line-primary-action" onClick={persistSettings} disabled={saveSettings.isPending || !settingsQuery.data?.linked} data-testid="button-save-line-settings">
                {saveSettings.isPending ? "儲存中…" : "儲存通知設定"}
              </button>
            </div>
            <p role="status" aria-live="polite" data-testid="status-line-settings-message">{statusMessage}</p>
          </>}
      </section>
    </main>
  );
}
