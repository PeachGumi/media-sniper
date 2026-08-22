# Media Sniper

[English](README.md) | **日本語**

プライバシー最優先のMV3ブラウザ拡張。今見ているページから動画・HLS/DASHストリーム・音声を検出してダウンロードします。ブラウザ自身のログインセッションを使うので、ログイン必須のサイトでも動作。アカウント登録もサーバーもテレメトリもなし。メディアはあなたのCookieでブラウザが取得し、そのまま `~/Downloads` に保存されます。

Chrome / Brave 対応（Manifest V3）。Brave 151で動作確認済み。

## なぜこれを使うのか

- **セッションをそのまま使う**: ダウンロードは普段のログイン状態のまま行われるので、ホットリンク保護されたCDNや認証付きHLSもそのまま動く。Video DownloadHelperと同じ発想で、アップセルなし
- **ちゃんとした1ファイル**: HLS VODはブラウザ内でffmpeg (WASM) を回して1本の `.mp4` に。AES-128暗号化も対応。DASHは映像+音声をmux。YouTubeの1080p以上（映像のみ+音声のみに分かれる形式）も別取得してローカルで結合
- **通信は最小限**: 解析なし、リモートコードなし、アップロード先なし。拡張が話す相手は、あなたが保存しようとしたメディアのCDNだけ

## 機能

| 分野 | 内容 |
|---|---|
| 検出 | 直接リンクのmp4/webm/音声、HLS（マスターを解像度ごとに展開）、DASH（トラック別）、`<video>`/`<audio>` のblobソース、YouTube adaptive形式 |
| ダウンロード | 同時3件のキュー。CDNに403で弾かれた場合、ページが使っていた認証ヘッダ（webRequestで取得したAuthorization/Referer等）を付けて自動リトライ |
| HLS | VODを `.mp4` にremux、AES-128復号、fMP4 + BYTERANGE、別トラック音声のmux（`EXT-X-MEDIA`）、音声のみ（`.aac`）、ライブ録画（停止ボタンで保存） |
| DASH | セグメント取得は自前管理+ローカルmux（libav.jsのdash demuxerデッドロックを回避）。映像+音声 or トラック単位 |
| YouTube | Progressive形式、最高音質の音声のみ、**adaptive mux**（映像のみmp4 + 音声mp4 → 1ファイル） |
| 一括保存 | 「全部保存」ボタン。保存済みファイルはスキップ（ダウンロード履歴と照合）。HLS/DASHジョブは1件ずつ順番に処理 |
| 設定 | Downloads内のルートフォルダ、小さいファイルの無視閾値、ドメイン単位のブラックリスト |
| ファイル名 | タイトルベース+サニタイズ、任意のルートフォルダ、同名は `uniquify` で退避 |

### 制限事項

- DRM保護されたストリーム（Widevine/EME。Netflix等の有料配信）は設計上ダウンロード不可
- MSE（blob:ストリーミングでplaylistを吐かないサイト）の検出は部分的。DevToolsでm3u8/mpdのリクエストが見えるなら Media Sniper も拾える
- 字幕はダウンロードしない

## インストール

ビルド不要・依存なし。リポジトリのまま読み込めます。

### 方法A: zipをダウンロード（git不要）

1. [最新リリース](https://github.com/PeachGumi/media-sniper/releases/latest) から `media-sniper.zip` をダウンロードして展開
   - macOS/Linux: ダブルクリック、または `unzip media-sniper.zip -d media-sniper`
   - Windows: 右クリック → すべて展開
2. ブラウザの拡張機能ページを開く
   - Brave: `brave://extensions`
   - Chrome / Edge / Chromium: `chrome://extensions`（Edgeは `edge://extensions`）
3. 右上の **デベロッパーモード** をON
4. **パッケージ化されていない拡張機能を読み込む** をクリックし、展開した `media-sniper` フォルダを選択
   - ⚠️ `manifest.json` が直接入っているフォルダを選んでください（その親ではない）

### 方法B: gitでクローン

```bash
git clone https://github.com/PeachGumi/media-sniper.git
```

その後は方法Aの手順2〜4と同じ。クローンした `media-sniper` ディレクトリを選択。

### 新バージョンへの更新

1. 新しいzipを入手（クローンした場合は `git pull`）
2. フォルダの中身を差し替え（または消して読み込み直し）
3. 拡張機能ページの Media Sniper カードの ↻ **再読み込み** ボタンを押す
4. 更新後に挙動がおかしければ、拡張を一度削除して読み込み直す（設定・ダウンロード履歴はブラウザ側にあるので消えません）

### 動作確認

- ツールバーに Media Sniper のアイコンが出る（パズルピースメニューからピン留め推奨）
- 動画のあるページを開いて再生し、アイコンをクリック → 検出したアイテムが一覧に出る
- 保存先は `~/Downloads/`（設定でルートフォルダを変えられます）

### トラブルシューティング

| 症状 | 対処 |
|---|---|
| 「パッケージ化されていない拡張機能を読み込む」が出ない | デベロッパーモード（手順3）がOFF |
| アイコンを押しても何も起きない | 拡張を再読み込みしてからポップアップを開き直す |
| アイテムが検出されない | ページ上でメディアを実際に再生/リクエストする必要があります。再スキャンも押してみてください |
| 保存はされるがファイルが再生できない | DRMまたはMSEのみのサイトの可能性。上の制限事項を参照 |
| ブラウザ更新後に拡張が消えた | 手順2〜4をやり直す（メジャーアップデート後は再読み込みが必要なことがある） |

> **注**: ストア経由でない拡張は、Chromeが時々「デベロッパーモードの拡張機能を無効にする」通知を出すことがあります。コードはすべてこのリポジトリ内で監査可能なので、無視して問題ありません。

## 使い方

日々の操作仕様（検出ルール、ボタンの挙動、ファイル命名、設定項目の詳細）は **[ユーザーガイド](docs/USAGE.ja.md)** にまとめています。

1. 動画/音声のあるページを開いて再生する（検出は実際のメディアリクエストを見ています）
2. Media Sniperアイコンをクリック → アイテムを選んで「保存」
3. `~/Downloads/`（または設定したルートフォルダ）に保存される

ライブHLSの場合、「保存」ボタンが「停止」に変わります。録画は随時fragmented MP4として書き込まれ、停止した時点でファイルが確定します。

## 仕組み

```
ページ ──webRequest(onResponseStarted/onSendHeaders)──▶ service worker
                                                        │ playlist解析、
                                                        │ 認証ヘッダ取得
                                                        ▼
                                              offscreen document
                                              (セッション付きfetch、
                                               ffmpeg WASM mux、
                                               createObjectURL)
                                                        │ blob URL
                                                        ▼
                                     chrome.downloads.download({filename})
```

- 純粋ロジックは `src/logic.js` に集約（worker/ページ/popup/テストで共有）
- ページワールドのbridge（`src/bridge.js`）はあえてfetch/XHRをラップしない（検出はwebRequestで完全カバー。ラップするとページ自身の失敗fetchの犯人に見えるため）
- ファイル名は `downloads.download` のオプションのみで指定。`onDeterminingFilename` リスナーは使わないので、他拡張のファイル名指定を壊さない

## 開発

```bash
npm test        # ユニットテスト（logic / bridge / background / youtube のVMスイート）
npm run check   # 全JSエントリポイントの構文チェック
npm run e2e     # ワンコマンドヘッドレスE2E: Brave起動+fixtureサーバー、
                #   検出+実ダウンロード+設定の往復を検証して後始末（exit 0 = PASS）
npm run zip     # 配布zipの作成
```

E2Eは専用の使い捨てブラウザプロファイルを使い、普段のブラウザには触れません。Brave/Chrome/Chromiumを自動検出（macOS/Windows/Linux対応）。`MEDIA_SNIPER_BRAVE=/path/to/binary` で明示指定も可能。CIはpushごとにユニットスイートを実行（`.github/workflows/ci.yml`）。

ディレクトリ構成:

```
src/logic.js      純粋ヘルパー（URL分類、命名、m3u8/mpdパース）
src/background.js service worker: 検出、キュー、HLS/DASHオーケストレーション
src/offscreen.js  バイトフェッチャー + ffmpeg WASMランナー (libav.js)
src/bridge.js     ページワールドの <video>/blob スキャナー
src/content.js    分離ワールドのリレー + メタデータ
src/youtube.js    MAINワールドのYouTubeアダプタ（streamingData読み取り）
popup/            popup UI + 設定ページ
test/             厳格なfake-chromeハーネスによるnode VMスイート
scripts/          E2Eランナー、CDPツール、フィクスチャ生成
```

## プライバシー

解析なし。テレメトリなし。メディア本体を配信したCDN以外への外部リクエストなし。設定は `chrome.storage.local`、検出アイテム一覧は `chrome.storage.session`（ブラウザを閉じると消去）に保存。

## ライセンス

Media Sniper本体のコードはMIT — [LICENSE](LICENSE) を参照。

`src/libav/` は [libav.js](https://libav.js.org) の **ffmpeg** ビルド（改変なし）を同梱しており、**LGPL-2.1** でライセンスされています（[LICENSE.libav](LICENSE.libav) 参照）。このプロジェクトのコードにはリンクしておらず、そのまま動的読み込みしているだけです。ソースコードは上流で入手できます。

## 免責事項

このツールは、あなたが正規にアクセスできるページから、個人利用の範囲でメディアをダウンロードするためのものです。利用するサイトの利用規約と著作権を尊重してください。所有していないコンテンツの再配布には使わないでください。
