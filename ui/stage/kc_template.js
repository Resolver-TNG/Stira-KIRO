// Stira-KIRO: the Stage DOM (StiraCore templates/stage.html minus what KiroCrew owns).
// Constant markup, no data goes into it. Used by the dashboard page and the frame harness.
export const TEMPLATE = `
<div id="stira-app" class="stage-app stage-shell" data-stage="live" data-board-svg="on">
  <div id="stage" class="stage">
    <canvas id="view-room" class="view view-room" aria-hidden="true" hidden></canvas>
    <canvas id="view" class="view" role="img" aria-label="Stage"></canvas>
    <p id="stage-still" class="stage-still" hidden><span data-i18n="stage.still_note">WebGL が使えないため静止画で表示しています。</span></p>
    <section id="board" class="board" hidden aria-labelledby="board-title" data-state="closed">
      <div class="board-housing" aria-hidden="true"></div>
      <div class="board-roll">
        <div id="board-head" class="board-head">
          <h2 id="board-title" class="board-title"><span class="board-tag" data-i18n="stage.board_tag">ボード</span> <span id="board-title-text"></span></h2>
          <span class="board-buttons">
            <button id="board-pin" class="mini" type="button" aria-pressed="false" data-i18n="stage.board_pin">📌 固定</button>
            <button id="board-copy" class="mini" type="button" data-i18n="stage.board_copy">コピー</button>
            <button id="board-close" class="mini" type="button" data-i18n="stage.board_close">× 閉じる</button>
          </span>
        </div>
        <div id="board-body" class="board-body md" tabindex="0" role="region" aria-labelledby="board-title"></div>
        <div class="board-foot"><span id="board-stats"></span><span id="board-note" class="board-note" role="status"></span></div>
      </div>
      <div class="board-weight" aria-hidden="true"></div>
    </section>
    <div id="choices" class="choices" role="group" aria-label="choices" hidden></div>
    <section id="approval-detail" class="approval-detail" hidden aria-labelledby="approval-detail-title">
      <h2 id="approval-detail-title" class="approval-detail-title"></h2>
      <dl id="approval-facts" class="approval-facts"></dl>
      <pre id="approval-args" class="approval-args" tabindex="0"></pre>
      <p id="approval-error" class="approval-error" role="alert"></p>
    </section>
    <section id="backlog" class="backlog" hidden aria-labelledby="backlog-title">
      <div class="backlog-head">
        <h2 id="backlog-title" class="backlog-title" data-i18n="stage.log_title">ログ</h2>
        <button id="backlog-close" class="mini" type="button" data-i18n="stage.log_close">× 閉じる</button>
      </div>
      <ol id="backlog-list" class="backlog-list" tabindex="0" aria-labelledby="backlog-title"></ol>
    </section>
    <section id="textbox" class="textbox" aria-label="text window" data-i18n-aria-label="stage.textbox_label">
      <div id="nameplate" class="nameplate">Kiro</div>
      <p id="asked" class="asked" hidden></p>
      <p id="line" class="line"></p>
      <p id="line-live" class="visually-hidden" aria-live="polite"></p>
      <button id="line-more" class="line-more" type="button" hidden data-i18n="stage.line_more">続きはログで</button>
      <form id="stage-form" class="composer" novalidate>
        <span class="prompt" aria-hidden="true">›</span>
        <label for="stage-input" class="visually-hidden" data-i18n="chat.message">メッセージ</label>
        <textarea id="stage-input" class="composer-input" rows="1" maxlength="16000"
                  placeholder="メッセージを入力" data-i18n-placeholder="stage.placeholder"
                  aria-describedby="stage-note"></textarea>
        <button id="stage-attach" class="attach" type="button" hidden data-i18n="chat.image">画像</button>
        <input id="stage-image-input" type="file" accept="image/png,image/jpeg,image/gif,image/webp" multiple hidden>
        <button id="stage-send" class="send" type="submit" data-i18n="chat.send">送信</button>
        <button id="stage-stop" class="send stop" type="button" hidden data-i18n="stage.stop">■ 表示を止める</button>
      </form>
      <div id="stage-images" class="img-chips" hidden></div>
      <p id="stage-note" class="composer-note" role="status"></p>
      <button id="stage-history-reload" class="mini" type="button" hidden data-i18n="chat.new_history_reload">再読み込み</button>
      <div id="stage-unsettled" class="unsettled" role="alert" hidden>
        <span id="stage-unsettled-text" class="unsettled-text"></span>
        <button id="stage-resend" class="mini" type="button" data-i18n="chat.unsettled_resend">同じ内容を再送</button>
        <button id="stage-discard" class="mini" type="button" data-i18n="chat.unsettled_discard">破棄</button>
      </div>
      <div class="foot">
        <span id="hint" class="hint"></span>
        <span class="buttons">
          <span id="conn" class="conn" role="status" data-state="unknown"></span>
          <span id="ctx-gauge" class="ctx-gauge" data-level="ok" hidden><span class="ctx-bar" aria-hidden="true" hidden></span><span class="ctx-text"></span></span>
          <button id="btn-new" class="mini" type="button" disabled aria-describedby="btn-new-reason" data-i18n="chat.new_button">新しい会話</button>
          <span id="btn-new-reason" class="visually-hidden"></span>
          <button id="btn-activity" class="mini" type="button" hidden aria-pressed="false" aria-controls="board" data-i18n="stage.act_toggle">稼働状況</button>
          <button id="btn-log" class="mini" type="button" aria-expanded="false" aria-controls="backlog" data-i18n="stage.log_toggle">ログ</button>
          <button id="btn-raw" class="mini" type="button" aria-pressed="false" aria-controls="raw">Raw</button>
        </span>
      </div>
    </section>
  </div>
  <section id="raw" class="raw" hidden aria-labelledby="raw-title">
    <h1 id="raw-title"></h1>
    <div class="raw-grid">
      <div id="raw-state"></div>
      <div id="raw-pose"></div>
      <div id="raw-log"></div>
      <div id="raw-drift"></div>
    </div>
  </section>
  <aside id="debug" class="debug" hidden aria-label="debug"></aside>
</div>`
