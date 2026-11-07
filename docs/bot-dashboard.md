# Bot ダッシュボードへの作業机表示 / Workbench on a Bot dashboard

> **お試し(試験中)/ Experimental.** Kiro Crew 0.12.0 の Bot と member records に合わせた試作。本体の仕様が変わると動かなくなることがある。Bot を指定しない限り何も送らない。
> A prototype built against Kiro Crew 0.12.0 Bots and member records; it may break when Kiro Crew changes. Nothing is sent until you name a Bot.

## 日本語

### この試作が送るもの

Stira Stage は、作業机を取得した後、設定された Bot の短い名前へ次の member record を送る。

- エンドポイント: `POST /api/member-records/<Bot slug>`
- record type: `desk`
- Bot の crew log に保存される記録キー: `stira_kiro__desk`
- 同じ内容は重複送信しない。ただし、最後の成功から5分経過した場合は鮮度表示のため再送する。
- 作業机の送信に失敗しても、作業机自体の取得・表示・fetch は続く。

`data` の形:

```json
{
  "red": 1,
  "yellow": 2,
  "green": 3,
  "total": 6,
  "needs": [
    { "name": "repository-name", "mark": "!", "text": "確認事項" }
  ],
  "clean": 3,
  "generatedAt": "2026-11-07T00:00:00+00:00"
}
```

`needs` は作業机と同じ順序の上位8件まで。`name` はリポジトリ名だけで、ローカルの個人パスは送らない。`text` はそのリポジトリの確認事項を ` / ` でつないだ先頭120文字。`data` 全体が8 KiBを超える場合は、末尾の `needs` から減らす。

### Bot ダッシュボードの binding

値は Bot の `custom` fold の `latest.stira_kiro__desk` に載る。書き方は2通りあるが、指しているものは同じ (fold 名と、その中の path を分けて書くか、つなげて書くか):

```json
{"fold":"custom","path":"latest.stira_kiro__desk.data.red"}
```

```text
custom.latest.stira_kiro__desk.data.red
```

Kiro Crew 0.12.0 の本体で確認した: `dashboard_types` は `custom.latest` を公開しており、アプリが書いた記録は `custom.latest.<app>__<type>.data` に載る (`dashboard/handlers/agent_panel_record_app.py`)。Bot のダッシュボードスキルでページを作るときは、モデルの field に `custom.latest.stira_kiro__desk` を宣言して行ごと受け取り、`data` の中を script で読むのが扱いやすい。

`data` には `red`、`yellow`、`green`、`total`、`needs`、`clean`、`generatedAt` がある。行には gateway が付ける記録時刻 `at` もあるので、ページに表示して古い記録を新しい状態に見せないこと (Stage の画面を開いている間しか送られないため、閉じていると値は古くなる)。

### Bot のチャットへ貼る依頼文

```text
Stira Stage の作業机の要約を、この Bot のダッシュボードにモデル呼び出しなしで表示するページを作ってほしい。member record の記録キーは stira_kiro__desk。red / yellow / green / total / clean を要約し、needs の name・mark・text を「手が要るもの」として一覧表示して。record の at も表示し、古い値は古いと分かる見せ方にして。ローカルの個人パスは表示しないで。値は custom.latest.stira_kiro__desk の行を model に宣言して受け取って。
```

## English

### What this prototype sends

After Stira Stage reads the workbench, it posts a member record to the configured Bot slug.

- Endpoint: `POST /api/member-records/<Bot slug>`
- Record type: `desk`
- Record key in the Bot crew log: `stira_kiro__desk`
- Identical data is not sent twice, except after five minutes from the last successful send so the page can show freshness.
- A send failure does not stop workbench reads, rendering, or fetch actions.

The `data` object has this shape:

```json
{
  "red": 1,
  "yellow": 2,
  "green": 3,
  "total": 6,
  "needs": [
    { "name": "repository-name", "mark": "!", "text": "attention item" }
  ],
  "clean": 3,
  "generatedAt": "2026-11-07T00:00:00+00:00"
}
```

`needs` contains at most the first eight actionable repositories in workbench order. `name` is only the repository name; no personal local path is sent. `text` joins that repository's issues with ` / ` and is limited to 120 characters. If the complete `data` object exceeds 8 KiB, entries are removed from the end of `needs` until it fits.

### Bot dashboard binding

The values land in the Bot's `custom` fold under `latest.stira_kiro__desk`. There are two spellings of the same place (the fold name and the path inside it, written apart or joined):

```json
{"fold":"custom","path":"latest.stira_kiro__desk.data.red"}
```

```text
custom.latest.stira_kiro__desk.data.red
```

Checked against Kiro Crew 0.12.0: `dashboard_types` publishes `custom.latest`, and a record an app writes lands at `custom.latest.<app>__<type>.data` (`dashboard/handlers/agent_panel_record_app.py`). When the Bot builds its page with the dashboard skill, declaring `custom.latest.stira_kiro__desk` in the model and reading `data` in script is the simplest.

`data` holds `red`, `yellow`, `green`, `total`, `needs`, `clean` and `generatedAt`. The row also carries the gateway's write time `at`: show it, so stale data reads as stale (Stage sends only while its page is open, so the values age while it is closed).

### Prompt to paste into the Bot chat

```text
Create a page on this Bot dashboard that shows the Stira Stage workbench summary without a model call. The member record key is stira_kiro__desk. Summarize red, yellow, green, total, and clean, and list needs.name, needs.mark, and needs.text as items that need attention. Show the record at timestamp and make stale values visibly stale. Do not display personal local paths. Declare the custom.latest.stira_kiro__desk row in the model to receive the values.
```
