---
name: worker-brief
description: サブエージェント(spawn_run)に実装・PR作成・調査を任せるときのブリーフの型。止まる文言を避け、検証と役割分担を固定する。
triggers: spawn_run, サブエージェント, ワーカー, ブリーフ, 並列実装, PR を作らせる, 委任
always: false
---

# worker-brief: ワーカーへの指示書の型

原典: Stira の運用メモ(GitHub 運用・並列ワーカー)。

## 役割
- ワーカー: 実装+テスト+PR 作成まで。マージしない。`Refs #N` だけ書く。
- 親(自分): ゲート再実行、独立レビュー、修正依頼、マージ、後片付け。
- 検証は実装したワーカーにさせない。別のサブエージェント(`include_memory=false`)か、親が結果を見て行う。

## 必須要素(欠けると止まる)
各タスク文字列に全文を入れる(`tasks` 配列では共通の `task` は届かない)。

```
目的: <1文>
作業場所: git -C <既存clone> worktree add --detach $KIROCREW_SCRATCH/<name> origin/main
         (既存ブランチの続きなら、そのブランチを checkout。新しいブランチを作らない)
Git author: git config user.name "<GitHubユーザー名>"
            git config user.email "<数値ID>+<ユーザー名>@users.noreply.github.com"
ブランチ: git checkout -b <feat|fix|docs|test|refactor|chore>/<短い説明>
実装: <変更するファイル・関数・受け入れ条件>
テスト: <正確なコマンド>(全部通ること)
仕上げ: commit → git push origin <ブランチ名> → gh pr create(draft にしない)
報告: PR の URL、実行したテストコマンドと結果、変更ファイル、残っていること

制約:
- main への直接 push 禁止。feature ブランチから PR のみ
- 外部サービス(API/メール/SNS)への送信禁止。GitHub への push と PR 作成は OK
- force push 禁止
- マージは親が行う。PR 本文に Closes/Fixes/Resolves は書かず Refs #N のみ
- <変更禁止の判断事項: 認可モデル・後方互換・課金など>
- 終わったら worktree で git status を確認し、未コミットを残さない
```

## 止まる文言(実際に止まった)
1. 「外部送信禁止」とだけ書かない → GitHub push も禁止と解釈して止まる。範囲を限定して許可を明示する。
2. 「コミットまで」と「push + PR 作成」を併記しない → 「コミットまで」が優先される。
3. 「PR は draft にしない」を明記する。

## 分け方
- 同時に 5〜6 本まで。同じファイルを触るタスクは直列にする。共通の枠組み(設定・マニフェスト)を先にマージしてから後続を載せる。
- 重い設計タスクは「最小の骨格を先に push」させる。ADR 更新と実装は別ワーカーか小刻み push。
- 大きな構造変更が main に入った後の依頼には「main を取り込んでから作業」を足す。
- レビュー指摘は原文を引用して渡す(要約しない)。依頼文に「前ラウンドで直したこと」と「探してほしい穴」を書き、最後に「マージしてよいなら MERGE と書く」。

## 受け取ったら
- 子の「成功」は主張。PR・ブランチ・テスト結果を自分で確かめる。
- 子が `Closes #N` と書いていたら、受け入れ条件に照らして親が判定し直す。
- 最終ラウンドの基準を宣言する:「再現付きの穴だけ blocking。今回が最後の修正ラウンド」。
