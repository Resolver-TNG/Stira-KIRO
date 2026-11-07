# 作業机プレビュー台

`desk.html` はインストール済みアプリを使わず、`ui/stage` の本番モジュールと `fixtures/repos.json` を読む。`frames.mjs` が一時的な localhost サーバーと headless Chrome を起動して撮影する。

```powershell
node tools/frames.mjs --page desk --from 120 --to 120 --step 1 --query "open=picker&lang=ja" --out .tmp/desk-picker
```

1件をボードに出す場合:

```powershell
node tools/frames.mjs --page desk --from 120 --to 120 --step 1 --query "open=board&repo=local-red&lang=ja" --out .tmp/desk-board
```

英語表示は `lang=en` に変える。既存の Stage 撮影は `--page` を省略すれば従来どおり `stage.html` を使う。
