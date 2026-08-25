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
| Privacy | 初期状態は常時site権限なし、確認済みmediaのみ認証headerを昇格、telemetryなし |

### 制限事項

- Widevine/EME等のDRM保護ストリームは対象外です。
- playlist/media URLを露出しないMSE-onlyサイトは検出できない場合があります。
- 字幕はダウンロードしません。
- Media Sniperは無制限サイズtranscoderではなく、処理方式ごとに明示的な安全上限を持ちます。直接browser downloadはoffscreen assemblerの上限対象外です。OPFS-backed concat/track assemblyは768MiBまで、DASH映像+音声のlocal muxはmemory-heavyなffmpeg段階に入る前のcombined inputを384MiBまでに制限します。詳細は [docs/MEMORY.md](docs/MEMORY.md)。

## インストール

1. [最新リリース](https://github.com/PeachGumi/media-sniper/releases/latest) を展開するか、このリポジトリをcloneします。
2. `brave://extensions` / `chrome://extensions` 等を開きます。
3. **デベロッパーモード**をONにします。
4. **パッケージ化されていない拡張機能を読み込む**から、`manifest.json`が直接入ったフォルダを選択します。

初回install時には、Media Sniperがメディア検出のため何を扱うか、認証付きmediaのrequest metadataをどう扱うか、保存場所・削除方法・外部送信の有無を説明するローカル画面を自動表示します。

### 更新

新しいreleaseでフォルダを置き換える（または`git pull`する）→ 拡張機能ページで再読み込みしてください。permission/privacy/security/third-party dependency変更はrelease notesで確認してください。

## 使い方

1. 動画/音声ページで実際に再生し、ブラウザにmediaをrequestさせます。
2. Media Sniperのpopupを開きます。これにより`activeTab`で**現在タブだけ**一時的に検出を有効化します。インストールしただけではWebサイトへの常時権限はありません。
3. 必要なら **「このサイトで常に有効」** または **「全サイトで常に有効」** を選びます。**「クリック時のみ」** に戻すと、Media Sniperへ与えた常時host権限を解除します。
4. アイテムの「保存」または「全部保存」を使います。
5. Downloadsまたは設定したサブフォルダへ保存されます。

サイト単位の許可を、Media Sniperが勝手に無関係なCDN originまで拡張することはありません。そのため、playlist/mediaが完全に別originのCDNから配信されるサイトでは、明示的な「全サイトで常に有効」の方がnetwork-level検出は完全になります。詳細は [docs/PERMISSIONS.md](docs/PERMISSIONS.md)。

詳しい操作は [docs/USAGE.ja.md](docs/USAGE.ja.md) を参照してください。

## Security / Privacy設計

Media Sniperはrequired host permissionなしでinstallされます。popupを開くと現在タブへの一時アクセスが与えられ、サイト単位/全HTTP(S)の常時アクセスはユーザーが明示的に選んだ場合だけoptional permissionとして取得します。Chromiumが現在許可しているorigin範囲内で、さらに次のtrust boundaryを適用します。

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
ユーザー操作 / optional site grant
              │
              ▼
       site-access manager
              │
page / player │
   │          │
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
                         OPFS assembly + bounded ffmpeg WASM
                                              │
                                              ▼
                                      browser Downloads
```

主要ファイル:

```text
src/background-entry.js      service worker entrypoint / security bootstrap
src/site-access.js           optional host grant / dynamic content scripts
src/security-guard.js        request/message trust boundary
src/background-lifecycle.js  queue/job/header/blobのbounded lifecycle policy
src/logic.js                 media解析・命名helper
src/dash-inheritance.js      DASH階層継承resolver
src/background.js            検出、queue、HLS/DASH orchestration
src/offscreen-policy.js      offscreen sender/memory/blob ownership policy
src/offscreen-streaming.js   OPFS-backed remote/HLS/DASH assembly
src/offscreen.js             ffmpeg/libav.js処理とfallback
src/content.js               isolated-world relay
src/bridge.js                page media/blob scanner
src/youtube.js               Full版YouTube MAIN-world adapter
popup/                       popup / site access / settings / 初回開示
```

## 開発・release check

```bash
npm test
npm run check
npm run e2e
npm run zip
```

Pull Requestと`main`では、unit/syntax、manifest/package/UI version整合、**required host権限がないこと**、optional host scopeがHTTP(S)だけであること、runtime/license/privacy必須ファイル、privacy scan、browser E2Eを自動検査します。

E2Eは `media-sniper.zip` を実際に生成し、そのZIPをクリーンなディレクトリへ展開した配布物そのものを固定versionのChrome for Testingへ読み込みます。クリーンprofileでは常時host権限が0件であることを確認した後、Permissions APIでoptional accessを許可し、dynamic detector登録、media検出、download、permission revoke、detector解除まで検証します。

さらにlibav media-engine gateとして、**AES-128暗号化HLS fixtureを配布ZIP内の実WASMで復号→stream-copy remux→MP4保存**し、Chromium Downloads完了・100KB超・MP4 `ftyp` signatureまで確認します。WASMが「buildできた」だけでは合格にしません。

CIは `src/libav/PROVENANCE.json` に記録されたmodule/WASMのSHA-256を再計算し、固定configと一致しないartifactや旧来の出所不明WASMが混入した場合は失敗します。

unit系jobと配布artifactのbrowser E2Eが両方成功した場合だけ、後段artifact jobが `media-sniper.zip` と `media-sniper.zip.sha256` をverified workflow artifactとして作成します。

承認済み`v*` releaseでは、extension ZIPに加えて **`media-sniper-libav-corresponding-source.tar.gz`** とそのSHA-256も生成・添付します。このsource bundleは、同梱WASMと同じ固定libav.js revision、生成variant config、展開済みdependency source、rebuild recipe、PROVENANCEを含みます。

正確なrelease手順とmanual acceptance checklistは [docs/RELEASE.md](docs/RELEASE.md) を参照してください。

## 配布

Full版にはYouTube adapter、adaptive mux、yt-dlp helperが含まれます。このfeature setをChrome Web Store互換artifactとは扱わないため、`media-sniper.zip` Full版をChrome Web Storeへ提出しないでください。

将来Web Store版を作る場合は別flavor/productとして、YouTube専用取得/mux/helper surfaceを除去し、そのartifactに一致するpermission/privacy/documentationを別途審査します。詳細は [DISTRIBUTION.md](DISTRIBUTION.md)。

## Third-party / ライセンス

Media Sniper自身のsourceはMITです。[LICENSE](LICENSE) を参照してください。

現在配布するlibav.js / FFmpeg WebAssembly runtimeは、`Yahweasel/libav.js` tag `v6.10.9.0`、commit `c80e885c3461f7bb7ea565c9631b34243ae0dbf1`、FFmpeg 9.0、Emscripten 6.0.5から生成するMedia Sniper専用の再現buildです。正確なfragment、compiler version、upstream revision、artifact SHA-256は `tools/libav/config.json` と `src/libav/PROVENANCE.json` に固定しています。

以前の`v6.5.7.1-61-g823eb97` WASMは正確なsource provenanceを復元できなかったため、現在の配布物・runtimeから削除しました。旧`.mjs` pathだけは既存import互換の薄いshimとして残し、新しい再現runtimeへredirectします。

承認済みreleaseではextension ZIPと同時に対応ソースbundleを添付します。詳細は [LICENSE.libav](LICENSE.libav)、[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)、[tools/libav/README.md](tools/libav/README.md) を参照してください。

## 免責事項

正規にアクセス・保存する権利があるmediaにのみ使用してください。著作権、契約、各サービスの利用規約を尊重してください。DRM回避は製品scope外です。
