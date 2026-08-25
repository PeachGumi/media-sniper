# Media Sniper

> **ブラウザで再生できる動画・音声を見つけて、そのまま保存する Chromium 拡張機能。**  
> MP4 / WebM / 音声ファイルだけでなく、HLS、DASH、Blob メディア、対応する YouTube の動画・音声にも対応します。

[![CI](https://github.com/PeachGumi/media-sniper/actions/workflows/ci.yml/badge.svg)](https://github.com/PeachGumi/media-sniper/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

Media Sniper は、Web ページ上でブラウザが実際に読み込んでいるメディアを検出し、Chromium のダウンロード機能を使って保存するための拡張機能です。

単純な動画ファイルだけでなく、複数のセグメントに分割された HLS / DASH、映像と音声が別々に配信される形式、AES-128 で暗号化された HLS なども、必要に応じてブラウザ内で結合・再多重化して保存します。

**Media Sniper 自身のサーバーはありません。** メディアの解析・結合処理はブラウザ内で行い、利用状況を送信する Analytics / Telemetry / 広告 SDK も使用していません。

---

## まず知りたいこと

### 何ができる？

- ページ内の **MP4 / WebM / 音声ファイル**を検出して保存
- **HLS（`.m3u8`）** を解析し、動画として保存
- **AES-128 HLS** をブラウザ内で復号して MP4 へ再多重化
- **DASH（`.mpd`）** の映像・音声トラックを取得して結合
- `<video>` / `<audio>` が使う **Blob URL** を検出
- 対応する **YouTube の progressive / audio-only / adaptive 形式**を取得
- HLS の**ライブ録画**
- 複数メディアの**一括保存**
- 認証が必要なメディアやホットリンク保護されたメディアを、現在のブラウザセッションを利用して取得

### 何はできない？

- **Widevine / EME などの DRM を回避する機能はありません**
- 字幕のダウンロードには対応していません
- メディア URL や playlist URL がブラウザから観測できないサイトでは、検出できない場合があります
- あらゆるサイトでの動作を保証する汎用クローラーではありません

---

## インストール

Media Sniper の現在のフル版は、Chrome Web Store ではなく **GitHub から取得して読み込む拡張機能**です。

### 1. Media Sniper を取得する

このリポジトリを clone するか、GitHub の **Code → Download ZIP** から取得して展開します。

```bash
git clone https://github.com/PeachGumi/media-sniper.git
```

ビルド作業は不要です。`manifest.json` があるフォルダをそのまま読み込めます。

### 2. Chromium に読み込む

Chrome の場合:

1. `chrome://extensions` を開く
2. **デベロッパー モード**を有効にする
3. **パッケージ化されていない拡張機能を読み込む**を選ぶ
4. `manifest.json` が入っている Media Sniper のフォルダを指定する

Brave では `brave://extensions` から同じ手順で読み込めます。

初回インストール時には、Media Sniper がメディア検出のために扱う情報、権限、保存場所、外部送信の有無を説明する画面が表示されます。

---

## 使い方

基本操作はシンプルです。

1. 保存したい動画・音声があるページを開く
2. 必要なら動画や音声を一度再生する
3. ツールバーの **Media Sniper** を開く
4. 検出されたメディアから保存したいものを選ぶ
5. **保存**を押す

複数の項目がある場合は **全部保存**も使用できます。

ファイルは通常の Chromium Downloads API を通して、`Downloads` または設定したサブフォルダへ保存されます。

### サイトへのアクセス権限

Media Sniper は、インストールしただけではすべての Web サイトを常時読み取れる状態にはなりません。

通常は、拡張機能をクリックした現在のタブだけを `activeTab` で一時的に有効化します。

必要に応じて次のモードを選べます。

| モード | 動作 |
|---|---|
| **クリック時のみ** | 拡張機能を開いた現在タブだけ一時的に有効化 |
| **このサイトで常に有効** | 現在サイトで自動的にメディアを検出 |
| **全サイトで常に有効** | HTTP / HTTPS サイト全体で自動検出 |

サイト本体と動画 CDN のドメインが異なるサービスでは、サイト単位の権限だけではネットワーク上のメディアをすべて観測できない場合があります。その場合だけ、明示的に「全サイトで常に有効」を使うと検出範囲が広がります。

詳しい操作方法は [docs/USAGE.ja.md](docs/USAGE.ja.md)、権限設計は [docs/PERMISSIONS.md](docs/PERMISSIONS.md) を参照してください。

---

## 対応しているメディア

| 種類 | 対応内容 |
|---|---|
| 直接ファイル | MP4、WebM、M4A、MP3、AAC、FLAC など |
| HLS | VOD、ライブ、AES-128、fMP4、BYTERANGE、別音声 rendition、音声のみ ADTS |
| DASH | MPD、SegmentTemplate、SegmentTimeline、階層継承、映像 + 音声 mux |
| Blob | `<video>` / `<audio>` が参照する Blob URL |
| YouTube | progressive、audio-only、adaptive video + audio mux |

Media Sniper は「拡張子だけを見る」のではなく、ページ・プレイヤー・ネットワーク通信から得られる情報を組み合わせて候補を検出します。

---

## HLS / DASH をどう保存しているのか

普通の MP4 であれば、その URL を Chromium のダウンロード機能へ渡せば保存できます。

一方、HLS や DASH は多数の小さなファイルに分割されているため、Media Sniper 側で追加処理を行います。

### HLS

1. `.m3u8` playlist を取得
2. variant / segment / encryption 情報を解析
3. 必要な segment を取得
4. 必要に応じて AES-128 を復号
5. libav.js / FFmpeg で MP4 へ remux
6. 完成したファイルを Downloads API へ渡す

### DASH

1. `.mpd` manifest を解析
2. `Period` / `AdaptationSet` / `Representation` の継承関係を解決
3. 映像・音声それぞれの segment を取得
4. 一時領域でトラックを組み立てる
5. 映像 + 音声をローカルで mux
6. 完成したファイルを保存

可能な限り**再エンコードは行わず、`-c copy` による stream copy / remux** を使います。そのため、動画を再圧縮する一般的な動画変換ソフトとは目的が異なります。

---

## メモリと大容量ファイル

Media Sniper は、巨大な動画を無制限に RAM へ読み込む設計にはしていません。

HLS / DASH の組み立てでは OPFS（Origin Private File System）を利用し、可能な処理は一時ディスクへ逐次書き込みます。また、ブラウザがメモリ不足で突然終了するよりも、処理可能な範囲を超えた時点で明示的に停止する方針を採っています。

現在の主な安全上限:

- OPFS を使う concat / track assembly: **768 MiB**
- DASH の映像 + 音声を FFmpeg で mux する場合: **合計入力 384 MiB**
- 通常の直接ダウンロード: 上記 assembler の制限対象外

詳細は [docs/MEMORY.md](docs/MEMORY.md) を参照してください。

---

## プライバシーとセキュリティ

Media Sniper は、ログイン済みサイトの動画などを扱えるようにする一方で、ページから得られるデータをそのまま信用しない設計にしています。

### 外部送信

Media Sniper には次のものがありません。

- Media Sniper 専用バックエンド
- Analytics
- Telemetry
- 広告 SDK
- リモートから取得して実行するコード

メディア処理は Chromium 内で完結します。

### 認証情報の扱い

認証付きメディアを取得するため、ブラウザが送信したリクエスト情報の一部を短時間参照することがあります。ただし、何でも保存するのではなく次の制約を設けています。

- 候補にするヘッダーは `Authorization` / `Referer` / `Origin` に限定
- レスポンスが実際にメディア / HLS / DASH と確認できた場合だけ利用
- 認証ヘッダーを extension storage へ永続保存しない
- 保持する状態には件数・時間の上限を設ける
- 認証情報を取得元とは別の origin へ転送しない
- 任意の `X-*` ヘッダーを収集しない
- ページ側から届くメッセージは信頼せず、sender / schema / URL を検証

Chromium 自身が対象 origin の Cookie を付与する場合はありますが、Media Sniper があるサイトの Cookie ヘッダーを別サイトへコピーすることはありません。

詳しくは以下を参照してください。

- [PRIVACY.md](PRIVACY.md) — プライバシーポリシー
- [SECURITY.md](SECURITY.md) — セキュリティ設計と脆弱性報告
- [docs/PERMISSIONS.md](docs/PERMISSIONS.md) — Chrome 権限の理由

---

## 制限事項

### DRM

Widevine / EME などで保護されたメディアの復号・回避は対象外です。

### MSE

Media Source Extensions を使うサイトでも、実際の playlist や media URL を観測できれば検出できる場合があります。ただし、外部から利用可能な URL が露出しない構成では保存できません。

### 字幕

現在は字幕ファイルを保存対象としていません。

### サイト依存

Web サービス側の実装変更により、昨日まで取得できたサイトが突然取得できなくなる可能性があります。特定サービスに依存する処理は、必要に応じて追従が必要です。

### Chrome Web Store

このリポジトリのフル版には YouTube 対応が含まれるため、**Chrome Web Store 用の成果物としては扱っていません**。現在は GitHub から取得して使用するセルフ配布版です。

詳細は [DISTRIBUTION.md](DISTRIBUTION.md) を参照してください。

---

## 主な設定

Media Sniper の設定画面では、主に次を変更できます。

- Downloads 内の保存先サブフォルダ
- 直接メディアを表示する最小ファイルサイズ
- 検出対象から除外するドメイン

「小さな広告動画やトラッキング用メディアまで大量に表示される」といった場合は、最小ファイルサイズや除外ドメインを調整できます。

---

## アーキテクチャ

```text
Web ページ / プレイヤー
        │
        ├─ DOM / Blob の検出
        └─ ネットワーク上のメディア候補
        │
        ▼
  Security Boundary
  sender / URL / header 検証
        │
        ▼
  MV3 Service Worker
  検出結果 / queue / HLS・DASH 制御
        │
        ▼
  Offscreen Document
  OPFS / libav.js / FFmpeg
        │
        ▼
 Chromium Downloads API
```

主要なコード:

| パス | 役割 |
|---|---|
| `src/background-entry.js` | Service Worker のエントリーポイント |
| `src/background.js` | 検出、保存キュー、HLS / DASH の制御 |
| `src/security-guard.js` | メッセージ・リクエストの信頼境界 |
| `src/site-access.js` | サイト権限と動的 Content Script |
| `src/background-lifecycle.js` | queue / job / header / Blob の寿命管理 |
| `src/logic.js` | URL 判定、命名、playlist / manifest 解析の共通処理 |
| `src/dash-inheritance.js` | DASH の階層的な `SegmentTemplate` 解決 |
| `src/offscreen-streaming.js` | OPFS を利用した逐次組み立て |
| `src/offscreen.js` | libav.js / FFmpeg を使う mux / remux |
| `src/content.js` / `src/bridge.js` | ページ内メディアの検出・中継 |
| `src/youtube.js` | YouTube 用アダプター |
| `popup/` | ポップアップ、設定、初回説明、権限 UI |

---

## libav.js / FFmpeg

HLS / DASH の mux・remux には、ブラウザ内で動く libav.js / FFmpeg WebAssembly を使用しています。

現在同梱している runtime は、次の固定された構成から再生成できます。

- libav.js: `v6.10.9.0`
- upstream commit: `c80e885c3461f7bb7ea565c9631b34243ae0dbf1`
- FFmpeg: `9.0`
- Emscripten: `6.0.5`

使用した設定、生成物の SHA-256、upstream revision は以下に記録しています。

- [`tools/libav/config.json`](tools/libav/config.json)
- [`src/libav/PROVENANCE.json`](src/libav/PROVENANCE.json)
- [`tools/libav/README.md`](tools/libav/README.md)

AAC / H.264 / HEVC decoder は入力ストリームのパラメータを取得するために含まれていますが、Media Sniper の通常出力は再エンコードではなく stream copy / remux です。

ライセンス情報は [LICENSE.libav](LICENSE.libav) と [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) を参照してください。

---

## 開発

Node.js があれば、主要な検証を実行できます。

```bash
npm test
npm run check
npm run zip
```

ブラウザ E2E:

```bash
npm run e2e
```

### CI で確認していること

Pull Request と `main` では、主に次を自動検証します。

- Unit Test
- JavaScript 構文チェック
- Manifest / package / UI version の整合性
- required host permission が存在しないこと
- 配布 ZIP に必要なファイルがすべて入っていること
- Privacy / Security 関連の静的チェック
- libav.js / WASM の provenance と SHA-256
- **実際に作成した `media-sniper.zip` を展開した状態でのブラウザ起動**
- 通常メディアの検出・保存
- HLS の検出・MP4 remux
- AES-128 HLS の復号・MP4 remux
- Chromium Downloads API での保存完了

つまり「ソースコード上ではテストが通るが、配布 ZIP では壊れている」という状態も CI で検出する設計です。

HLS の E2E fixture は CI 内で実際の FFmpeg から生成しており、壊れた固定バイナリを正常データと誤認しないようにしています。

詳しいリリース検証は [docs/RELEASE.md](docs/RELEASE.md) を参照してください。

---

## ドキュメント

より詳しく知りたい場合はこちらを参照してください。

| ドキュメント | 内容 |
|---|---|
| [docs/USAGE.ja.md](docs/USAGE.ja.md) | 詳しい使い方 |
| [docs/PERMISSIONS.md](docs/PERMISSIONS.md) | 権限を要求する理由 |
| [docs/MEMORY.md](docs/MEMORY.md) | 大容量メディアとメモリ設計 |
| [PRIVACY.md](PRIVACY.md) | プライバシーポリシー |
| [SECURITY.md](SECURITY.md) | セキュリティ設計・脆弱性報告 |
| [SUPPORT.md](SUPPORT.md) | 対応範囲とサポート方針 |
| [DISTRIBUTION.md](DISTRIBUTION.md) | 配布方針 |
| [CONTRIBUTING.md](CONTRIBUTING.md) | 開発への参加方法 |
| [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) | サードパーティソフトウェア |

---

## ライセンス

Media Sniper 本体は [MIT License](LICENSE) です。

同梱している libav.js / FFmpeg などのサードパーティコンポーネントには、それぞれのライセンスが適用されます。詳細は [LICENSE.libav](LICENSE.libav) と [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) を確認してください。

---

## 免責事項

Media Sniper は、**自分にアクセス・保存する権利があるメディアを保存するために使用してください。**

著作権、契約、各サービスの利用規約を尊重してください。DRM の回避は Media Sniper の対象外です。
