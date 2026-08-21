# Media Sniper

MV3 ブラウザ拡張 (Brave/Chrome): いま開いてるページから動画・HLS・音声を
ブラウザ自身のセッション付きで検出して保存する。VDH (Video DownloadHelper)
の検知ロジックを解析して参考にしつつ、ゼロから書いたオリジナル実装。

## なにができるか

- ページの通信を監視して mp4/webm/mkv/mp3/m4a 等を自動検出
  (webRequest でレスポンスヘッダ直読み + ページ側で fetch/XHR/video要素監視の二重経路)
- HLS (m3u8) はプレイリスト本体を検証してから一覧に出す。保存時は最高ビットレートの
  バリアントを選んでセグメントを全部取得・結合して単体ファイル (.ts / fMP4 は .mp4) にする
- 保存先: `~/Downloads/` 直下 (フォルダ管理なし、保存確認ダイアログも出さない)
- ページタイトルをファイル名に使う
- blob: 動画 (MSE) の検出
- 対応しきれないケース用に yt-dlp コマンドのコピーボタン

## インストール

1. brave://extensions (または chrome://extensions) → デベロッパーモード ON
2. 「パッケージ化されていない拡張機能を読み込む」→ このフォルダを指定
3. 更新時は拡張の再読み込み + 対象ページのリロード

## 使い方

1. 動画ページを開いて再生
2. ツールバーのアイコン(バッジに検出数が出る)をクリック
3. リストから「保存」
4. HLS は「取得中 → % → 保存中」の順に進む

## 設計 (VDH解析で得た知見の反映)

- 検知の主軸は `webRequest.onResponseStarted` (VDHと同じ)。content scriptが
  動かないページでも検知できる
- m3u8判定は content-type `mpegurl` + URLパターン (`/hls/`, `/api/playlist/master/`)
- `.ts/.m4s` セグメントは個別に報告しない (リストがゴミで埋まる対策)
- 字幕専用プレイリスト (全URIが vtt/srt) は除外
- MIME→拡張子テーブルでフォールバック命名
- HLS結合はサービスワーカー内で完結 + offscreen document で blob URL 生成
  (SWに `URL.createObjectURL` が無いため。VDHもoffscreenを使う)

## v0.2.0 の重要変更 (2026-08-18)

- **`chrome.downloads.onDeterminingFilename` を完全に削除した**。
  blob保存の命名をこのイベントに依存していた旧版は、次の経路で
  リスナーが漏洩し、**ブラウザ内の全拡張機能**(Media Harvest・TikTok・
  Gofile等)の `downloads.download({filename})` によるフォルダ分類・
  ファイル名を破壊していた(実機事故 2026-08-18):
  1. blob→ファイル名対応表を `storage.session` に永続化
  2. SW再起動のたびに `restoreBlobMap()` が残骸を読み込みリスナーを再登録
  3. リスナーが居る限り全ダウンロードのファイル名決定が自分のハンドラ経由になり、
     他拡張への `suggest()` 素呼びがChromium側でcreator filenameをリセット
- 新方式: Media Harvest と同じく `downloads.download({ url, filename })` の
  filenameオプションだけで命名。blob: URLでもこのオプションが効くことを
  Brave 151 で実測確認済み(ヘッドレスE2Eで blob→正しいファイル名保存を再現)
- このブラウザでは ODF は blob: ダウンロードに対して元々発火しないため、
  旧実装は自分の命名すら通っていなかった(UUID直置きになっていた)
- HLS取得は `credentials: 'include'` なのでログイン必須サイトでも
  ブラウザのCookieが乗る

## 限界

- AES-128 暗号化HLS: 未対応 (エラー時に yt-dlp を案内)
- DASH (.mpd): 検出するが保存未対応 (yt-dlp ボタンで回避)
- DRM (Widevine): 対象外
- ライブHLS: プレイリストのスナップショット取得になる

## 開発

```
npm test          # ユニットテスト 341件 (logic/bridge/background/youtube VM)
npm run check     # 全JS構文チェック
npm run e2e       # ワンコマンドE2E: Brave起動 → fixture → 検出 → 実DL → 設定/一括保存検証 → 自動後始末
npm run zip       # 配布zip
```

- `scripts/run_e2e.py` — E2Eランナー。ヘッドレス専用プロファイル (~/.cache/ms-brave-test-e2e) を使い、日常ブラウザには触れない。exit code 0=PASS / 1=FAIL
- `scripts/sw_eval.py` — CDP経由でSWの中の式を実行 (デバッグ用)
- `scripts/make_fixture.py` — ローカルHLSテストページ生成
- `test/fixture/hls/` — 検証用フィクスチャ

## プライバシー

解析・外部送信なし。取得したメディアは chrome.downloads 経由でローカル保存のみ。
