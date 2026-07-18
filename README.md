# 315

固定された 5×5×5 Perfect Magic Cube（1〜125を一度ずつ使用、各ライン合計315）を扱うプロジェクト。

## 構成

GitHub Pages が `/docs` からの配信のみ対応のため、ビューアー一式は `docs/` 直下に置いている。

- `docs/cube_data.json` — 正解データ（source of truth）。Walter Trump & Christian Boyer, 2003-11-13
- `docs/index.html` / `docs/style.css` / `docs/script.js` — キューブを立体（アイソメトリック・遠近法）で表示するビューアー本体

## viewer の使い方

GitHub Pages: `https://sanadamancom.github.io/315/`
ローカル: `docs/index.html` をブラウザで開くだけで動作する（ビルド不要、素のHTML/CSS/JS）。

- 背景をドラッグ：自由回転
- 上部ボタン：90度単位のスナップ回転
- ブロックの境目にカーソルを合わせてクリック：その1箇所だけ分離・復元
- 「分離を閉じる」：すべての分離を元に戻す

中心（63が入っているブロック）は常に固定され、各境目は中心から遠い側のブロックだけが動く。
