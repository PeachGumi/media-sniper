# Media Sniper

[English](README.md) | **日本語**

プライバシーを重視したManifest V3ブラウザ拡張です。今見ているページから直接メディア、HLS/DASH、音声、Blobメディア、対応するYouTube形式を検出し、現在のブラウザセッションを使って保存します。

解析・mux/remuxはChromium内で行います。Media Sniperのバックエンド、analytics、telemetry、広告SDK、リモート実行コードはありません。

> **配布方針:** このリポジトリのFull版はGitHub Releases/ソースからself-distributionし、デベロッパーモードでunpacked拡張として読み込みます。**Chrome Web Store版ではありません。** 詳細は [DISTRIBUTION.md](DISTRIBUTION.md) を参照してください。

## 機能

| 分野 | 内容 |
|---|---|
| 検出 | 直接mp4/webm/音声、HLS、DASH、`<video>`/`<audio>` のBlobソース、対応するYouTube形式 |
| ダウンロード | 上限付きキュー、認証/ホットリンク保護メディアのbrowser-session-aware fallback |
| HLS | VOD remux、AES-128、fMP4/BYTERANGE、別音声rendition、音声のみADTS、ライブ録画 |
| DASH | 自前のsegment解決/取得、継承された`SegmentTemplate`対応、映像+音声のローカルmux |
| YouTube | progressive、音声のみ、adaptive映像+音声mux（Full self-distributed版） |
| 一括保存 | 保存済みチェック、HLS/DASHジョブの直列処理 |
| 設定 | Downloads内サブフォルダ、直接メディア最小サイズ、ドメインblacklist |
| Privacy | 確認済みmediaのみ認証headerを昇格、sensitive headerのorigin境界、telemetryなし |

### 制限事項

- Widevine/EME等のDRM保護ストリームは対象外です。
- playlist/media URLを露出しないMSE-onlyサイトは検出できない場合があります。
- 字幕はダウンロードしません。
- 数GB級メディアでは一部HLS/DASH/mux経路がまだ大きなRAMを使います。現時点では無制限サイズ対応とは扱いません。

## インストール

1. [最新リリース](https://github.com/PeachGumi/media-sniper/releases/latest) を展開するか、このリポジトリをcloneします。
2. `brave://extensions` / `chrome://extensions` 等を開きます。
3. **デベロッパーモード**をONにします。
4. **パッケージ化されていない拡張機能を読み込む**から、`manifest.json`が直接入ったフォルダを選択します。

初回install時には、Media Sniperがメディア検出のため何を観測するか、認証付きmediaのrequest metadataをどう扱うか、保存場所・削除方法・外部送信の有無を説明するローカル画面を自動表示します。

### 更新

新しいreleaseでフォルダを置き換える（または`git pull`する）→ 拡張機能ページで再読み込みしてください。permission/privacy/security/third-party dependency変更はrelease notesで確認してください。

## 使い方

1. 動画/音声ページで実際に再生し、ブラウザにmediaをrequestさせます。
2. Media Sniperのpopupを開きます。
3. アイテムの「保存」または「全部保存」を使います。
4. Downloadsまたは設定したサブフォルダへ保存されます。

詳しい操作は [docs/USAGE.ja.md](docs/USAGE.ja.md) を参照してください。

## Security / Privacy設計

自動media検出という主要機能のため広いsite accessを使いますが、次のtrust boundaryで用途を制限します。

- request headerはまずrequest ID単位の短命・上限付きpending bufferだけに保持します。
- capture候補は `Authorization` / `Referer` / `Origin` に限定します。
- 対応responseがmedia/HLS/DASHと確認された場合だけmedia用header cacheへ昇格します。
- 任意の`X-*` request headerをmedia用に収集しません。
- sensitive headerは取得元originへbindし、extension管理のcross-origin fetchでは除去します。
- page/content scriptから来るdataはuntrustedとしてschema検証し、payloadのtab ID/page URLを信用しません。
- download/settings/clear/queue等の特権操作はMedia Sniper自身のextension pageからだけ受理します。
- Authorization等はextension storageへ永続化せず、確認済みmedia用header cacheにも保持期限があります。
- 完了済みqueue/job履歴は上限付きで、extension自身が作ったBlob URLは明示release＋TTL fallbackで管理します。
- blacklist対象はmedia itemにもrequest metadata昇格にも使いません。

Chromium自身は、対象media originへのcredentialed fetch時に、そのorigin向けCookieを付ける場合があります。Media Sniperが別originのCookie headerをコピーして送るわけではありません。

詳細は [PRIVACY.md](PRIVACY.md)、[docs/PERMISSIONS.md](docs/PERMISSIONS.md)、[SECURITY.md](SECURITY.md) を参照してください。

## 構成

```text
page / player
   │
   ├─ webRequest response metadata ───────────────┐
   └─ page/contentのmedia report (untrusted) ──┐ │
                                              ▼ ▼
                                      security boundary
                                              │
                                              ▼
                                      service worker
                              detection / queue / HLS-DASH
                                              │
                                              ▼
                                      offscreen document
                              session fetch + ffmpeg WASM
                                              │
                                              ▼
                                      browser Downloads
```

主要ファイル:

```text
src/background-entry.js      service worker entrypoint / security bootstrap
src/security-guard.js        request/message trust boundary
src/background-lifecycle.js  queue/job/header/blobのbounded lifecycle policy
src/logic.js                 media解析・命名helper
src/dash-inheritance.js      DASH階層継承resolver
src/background.js            検出、queue、HLS/DASH orchestration
src/offscreen-policy.js      offscreen sender/memory/blob ownership policy
src/offscreen.js             byte処理 + ffmpeg/libav.js
src/content.js               isolated-world relay
src/bridge.js                page media/blob scanner
src/youtube.js               Full版YouTube MAIN-world adapter
popup/                       popup / settings / 初回開示
```

## 開発・release check

```bash
npm test
npm run check
npm run e2e
npm run zip
```

Pull Requestと`main`では、unit/syntax、manifest/package/UI version整合、runtime/license/privacy必須ファイル、privacy scan、browser E2Eを自動検査します。E2Eはまず `media-sniper.zip` を実際に生成し、**そのZIPをクリーンなディレクトリへ展開した配布物そのもの**を固定versionのChrome for Testingへ読み込んで実行します。source treeにしか存在しないファイルでE2Eが偶然PASSすることはありません。

unit系jobと配布artifactのbrowser E2Eが両方成功した場合だけ、後段artifact jobが `media-sniper.zip` と `media-sniper.zip.sha256` をverified workflow artifactとして作成します。

`v*` tagも同じgateを通ります。tag versionがmanifest/package versionと一致し、全checkが成功し、repositoryの明示的なrelease approval gateが有効な場合だけGitHub Releaseを作成し、ZIPとSHA-256ファイルを添付します。v1/commercial blockerが残っている間はapproval fileを意図的に置かないため、誤ってtagを作っても公開releaseにはなりません。

E2Eはthrowaway browser profileを使用し、extension IDを実行時に検出します。`MEDIA_SNIPER_EXTENSION_ROOT` を指定するとrepo本体とは別の展開済みartifactをテストできます。

正確なrelease手順とmanual acceptance checklistは [docs/RELEASE.md](docs/RELEASE.md) を参照してください。

## 配布

Full版にはYouTube adapter、adaptive mux、yt-dlp helperが含まれます。このfeature setをChrome Web Store互換artifactとは扱わないため、`media-sniper.zip` Full版をChrome Web Storeへ提出しないでください。

将来Web Store版を作る場合は別flavor/productとして、YouTube専用取得/mux/helper surfaceを除去し、そのartifactに一致するpermission/privacy/documentationを別途審査します。詳細は [DISTRIBUTION.md](DISTRIBUTION.md)。

## Third-party / ライセンス

Media Sniper自身のsourceはMITです。[LICENSE](LICENSE) を参照してください。

`src/libav/` にはlibav.js / FFmpeg WebAssembly artifactをvendorしています。適用されるLGPL noticeは [LICENSE.libav](LICENSE.libav)、詳細なprovenanceは [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) を参照してください。

同梱generated JavaScript moduleにはdownstream modificationの記録があり、build identifierは `libav.js v6.5.7.1-61-g823eb97` です。現repository historyだけでは、**同梱binaryと正確に対応するsource/build recipeをまだ特定できていません**。したがって「公式v6.5.7.1の無改変binary」「generic upstream checkoutが対応ソース」とは表現しません。このprovenanceを解決するか再現buildへ置換することは、commercial v1.0 releaseのgateです。

## 免責事項

正規にアクセス・保存する権利があるmediaにのみ使用してください。著作権、契約、各サービスの利用規約を尊重してください。DRM回避は製品scope外です。
