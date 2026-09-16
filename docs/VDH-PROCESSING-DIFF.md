# VDH と Media Sniper の処理単位差分

この文書は、参考実装である Video DownloadHelper (VDH) の実バンドルと Media
Sniper の実装を**処理単位ごと**に対比した棚卸しです。目的は 2 つあります。

1. 「VDH ではできるのに Media Sniper ではできない」項目を列挙して解消する。
2. 解消済み・実装が違うだけ・意図的に非対応、を区別して記録する。

方法は clean-room です。VDH 側は 10.5.49.2 の展開済みバンドルを読むだけで、
コード・変数名・セレクタ・内部構造は一切流用していません (観測した挙動・構造と
公開標準のみを根拠にしています)。VDH 側の証拠は minified コードからの抜粋で、
出典ファイルを併記します。Media Sniper 側は現行ソースを指します。

判定の種類:

- **同等** — 同じ処理単位を同じ形で備えている
- **実装が違うが同等** — 手段は違うが能力・結果は同じ
- **Media Sniper が劣る** — 同じことができるべきなのに制限・欠陥がある
- **未対応** — 機能自体が無い

## 処理単位の対比

### 1. ページからの取り込み (ingest)

| | |
|---|---|
| VDH | service worker + content script + injected script で `webRequest` とページ内 API を監視し、検出結果をアダプタ (`content/details.js`) が論理メディアへ正規化 |
| Media Sniper | 同じ層構成 (`src/background.js` の `onResponseStarted`/`onSendHeaders`、`src/page-metadata.js`、`src/bridge.js`、`src/detectors`) |
| 判定 | **同等** (clean-room 実装) |

### 2. 認証文脈 (cookie / 送信ヘッダ)

| | |
|---|---|
| VDH | メディア取得要求を `webRequest` で観測し、プレイヤーが送ったヘッダを再現する (bundle 内に `sent_headers` 相当の保持と jsfetch への引き渡し) |
| Media Sniper | `onSendHeaders` で `referer`/`origin`/`authorization`/`x-*` を URL キーで保持し、jsfetch・fallback・セグメント取得で再生 (`headersFor`)。クロスオリジンでは referer/origin を落とす |
| 判定 | **同等**。cookie は両者ともブラウザセッション依存 (`credentials: 'include'`) |

### 3. HLS 解析

| | |
|---|---|
| VDH | master/media の判別、variant 一覧、`EXT-X-MEDIA` (AUDIO / SUBTITLES) rendition、`EXT-X-MAP`、`EXT-X-BYTERANGE`、AES-128 を処理 |
| Media Sniper | `src/logic.js` の `parseM3u8` が master/media、variant、`audioGroup`、`initUrl` (EXT-X-MAP)、暗号化、live 判定 (ENDLIST 無し) を処理。**subtitleGroup は未解析** |
| 判定 | AUDIO rendition は**同等**、`SUBTITLES` は **未対応** (下記 12) |

### 4. DASH 解析と表現選択

| | |
|---|---|
| VDH | `-f dash -mpd_video_idx <entry> -i jsfetch:<mpd>` を ffmpeg に渡し、表現の選択を ffmpeg の dash demuxer に任せる (`download_worker/main.js`) |
| Media Sniper | 自前で MPD を解析し (`src/dash-inheritance.js`)、選択した映像/音声トラックのセグメントを取得して mux |
| 判定 | **実装が違うが同等**。ffmpeg 内で完結させる VDH 方式は入力が jsfetch のストリームのままなので入力サイズの制約が無い。Media Sniper は 2026-09-16 に mux 入力を block reader device 化して同じ性質を得た (下記 8) |

### 5. セグメント取得の主体

| | |
|---|---|
| VDH | 主に ffmpeg 自身 (jsfetch プロトコル)。セグメント単位の検証は `writeFile` + `ff_init_demuxer_file` で行い、期待する映像/音声が無ければ `bad_segment` (`download_worker/main.js`) |
| Media Sniper | HLS は ffmpeg の jsfetch、DASH/音声のみの HLS/remote fallback は自前 (`src/offscreen-streaming.js`)。**セグメント単位の破損検出は無い** |
| 判定 | 取得は**同等**、破損検出は**未対応** (下記 13) |

### 6. ffmpeg の実行環境

| | |
|---|---|
| VDH | 専用 Worker (`download_worker/main.js`)。このため OPFS の同期アクセスハンドルなど Worker 専用 API が使える |
| Media Sniper | offscreen document (`src/offscreen.js` を module script として読み込み)。`noworker: true` で wasm を読み、ライブ録画中は keepalive port で service worker を起こし続ける |
| 判定 | **実装が違うが同等**。同期アクセスハンドルは offscreen 文書では使えないため、出力は非同期書き込みのバッチ化で同等の速度にしている (下記 8) |

### 7. ffmpeg 実行引数 (HLS → MP4)

| | |
|---|---|
| VDH | `-analyzeduration 10M -f hls -i jsfetch:<video>` (+ `-i jsfetch:<audio>` / `-i jsfetch:<subtitle>`)、`-c:v copy -c:a copy`、`-avoid_negative_ts`、字幕は `-c:s mov_text` か `copy` + `language=` メタデータ |
| Media Sniper | `-protocol_whitelist file,data,jsfetch,crypto,http,https -analyzeduration 10M -f hls -i jsfetch:<media>`、別レンディション音声は 2 本目の `-i` + `-map 0:v:0 -map 1:a:0?`、`-c copy`、`-avoid_negative_ts make_zero`。ライブは `-movflags frag_keyframe+empty_moov+default_base_moof` と `-bsf:a aac_adtstoasc` (2026-09-16 追加) |
| 判定 | 映像/音声は**同等**、字幕は**未対応**。ライブの `-bsf:a aac_adtstoasc` は VDH バンドルには見当たらず、ffmpeg のバージョン差で自動挿入に頼れないビルドでの必須回避策 |

### 8. 出力 I/O とダウンロード受け渡し

| | |
|---|---|
| VDH | 出力は `mkwriterdev` + 自前 writer クラス。`createSyncAccessHandle()` で得た OPFS ハンドルへ `write(data, {at: position})`。完成後は blob URL とダウンロード ID を対応づけて保存 |
| Media Sniper | `mkwriterdev` + OPFS sink (`src/offscreen-streaming.js` の `createOutputSink`)。連続する muxer 書き込みを 8 MiB 単位にまとめて `createWritable().write({position, data})` に渡し、完成物は disk-backed な `File` URL のまま `chrome.downloads.download` へ渡す |
| 判定 | **実装が違うが同等**。2026-09-16 までは「全書き込みをメモリに溜めて最後に Blob を 1 個作る」実装で、768 MiB を超えると失敗していた (実測 1.19 GB の保存で解消を確認) |

### 9. 進捗

| | |
|---|---|
| VDH | `ffmpeg_get_out_time_ms()` / `ffmpeg_get_total_size_bytes()` をポーリングして `download_progress` を送る |
| Media Sniper | 同じ API は**バンドルに存在しない** (0 箇所) ため、sink の書き込みバイト数と jsfetch の要求数/受信バイトから自前で進捗を作り、`ms-offscreen-progress` → job → popup へ流す |
| 判定 | **実装が違うが同等** (むしろ実測値が正しい) |

### 10. 実行中ジョブの停止 (中断)

| | |
|---|---|
| VDH | `ffmpeg_interrupt` を含む libav ビルドを使い、実行中の ffmpeg を中断できる |
| Media Sniper | バンドルに `ffmpeg_interrupt` も module 直下の `abortController` も無い。2026-09-16 に「開いている jsfetch 応答を cancel + 以後の要求を拒否」で中断を実装 (`abortFfmpegJob`) |
| 判定 | 以前は **Media Sniper が劣る** (停止ボタンが実質無効) → 現在は**実装が違うが同等** |

### 11. ライブ録画 (DVR)

| | |
|---|---|
| VDH | ライブ プレイリストを ffmpeg に渡し、停止操作で中断。断片化 MP4 として保存 |
| Media Sniper | 同じ流れ。ただし 2026-09-16 まで TS セグメントのライブで**最初の AAC パケットで mux が失敗し、1 秒で終了した壊れた MP4 を「保存しました」と報告**していた (原因は 7 の bsf 欠落と、live 時に rc≠0 を成功扱いする判定) |
| 判定 | 以前は **Media Sniper が劣る** → 現在は**同等** (bsf 追加 + 無人で小さい成果物は失敗として報告) |

### 12. 字幕

| | |
|---|---|
| VDH | 字幕レンディションを取得し、`-map <n>:s:0?` + `-c:s mov_text` (MP4) または `copy` + `language=` で mux する |
| Media Sniper | **未対応**。検出段階で字幕プレイリストを明示的に除外している (`isSubtitlePlaylist`、`src/background.js` の検出、`test/background.test.js` に「subtitle playlist rejected」のテストあり) |
| 判定 | **未対応**。加えて現行バンドルでは原理的に不可能: libav のビルドフラグに `--enable-encoder=...` が 1 つも無く (`src/libav/libav-*.wasm.wasm` の configure 文字列で確認)、`mov_text` エンコーダが存在しない。字幕を埋め込むには libav 成果物の再ビルドが必要 (下記「残差」参照) |

### 13. 破損セグメントの扱い

| | |
|---|---|
| VDH | セグメントを MEMFS に置いて demux を試し、期待する映像/音声が無ければ `bad_segment` として扱う |
| Media Sniper | ffmpeg の demux/mux エラーと、interrupted ダウンロードの認証付き fallback 経路で代替。セグメント単位の判定は行わない |
| 判定 | **未対応** (実害が出た場合の追加候補) |

### 14. ジョブの永続化と worker 再起動

| | |
|---|---|
| VDH | service worker 側でダウンロード状態を保持し、worker の寿命に依存しない設計 (bundle 内の port/keepalive と storage の併用) |
| Media Sniper | `msItems` / `msActiveJobs` / `msActiveQueue` を session storage に保持し、worker 再起動後に実行中変換の再接続・未着手ジョブの再実行・Downloads 状態の照合を行う (`recoverRestoredMediaJobs`、`reconcileRestoredQueueEntry`) |
| 判定 | **同等** (再起動 E2E で検証済み) |

### 15. ダウンロード命名と競合

| | |
|---|---|
| VDH | タイトル + 拡張子で保存し、既存ファイルとは衝突回避する |
| Media Sniper | `normalizeItem` がタイトルからファイル名を作り、`conflictAction: 'uniquify'` で番号付け。disk-backed な `File` URL でも指定ファイル名が維持されることを実機で確認済み |
| 判定 | **同等** |

### 16. 権限モデル

| | |
|---|---|
| VDH | インストール時に広いホスト権限を持つ |
| Media Sniper | 既定は `activeTab`、必要時にユーザー操作で `http(s)://*/*` を要求 (`docs/PERMISSIONS.md`) |
| 判定 | **意図的な差** (能力差ではない) |

## 2026-09-16 に埋めた差

1. **出力のメモリ組み立て** → OPFS sink (連続書き込みの 8 MiB バッチ、disk-backed `File` URL を Downloads へ)。実測 1,192,552,190 バイトの保存に成功。
2. **進捗が 0s/0B のまま** → 実在する値 (書き込みバイト、fetch 数) に置換。
3. **停止が効かない** → jsfetch cancel + 停止中ジョブの fetch 拒否 (jsfetch が `FetchWithRetry` ではなく素の `fetch` を呼ぶため、拒否は global fetch 側に置く)。実測: 停止操作の直後 (0.0 秒) に Downloads へ。
4. **ライブ録画が即死** → `-bsf:a aac_adtstoasc` を TS ライブに限定して付与 (この muxer は ADTS→ASC を自動変換しない)。無人で小さい成果物は失敗として報告。実測: 22 秒の部分録画が再生可能。
5. **mux 入力のメモリ上限 (384 MiB)** → `mkblockreaderdev` + `onblockread` による disk-backed 入力 (ffmpeg は OPFS ファイルを直接読む)。実装上の必須条件: libav はデバイスのバッファ表を **MEMFS ノード名**で引くため、デバイス登録名・ffmpeg に渡すパス・`ff_block_reader_dev_send` の名前をすべて同じ「素の名前」(`v.mp4`) に揃える必要がある。パス (`/v.mp4`) で登録すると読み出しが EAGAIN のまま無限に待つ (実測で踏んだ)。実測: 794,370,663 バイト (映像+音声の合計が旧上限超) の DASH mux が成功、ffprobe で映像+音声、duration 200.02 秒。

## 残差

- **字幕 (12)**: 未対応。しかも現行 libav 成果物には **エンコーダが 1 つも入っていない** (`--enable-encoder=...` が configure に無い) ため、`-c:s mov_text` が使えない。実装するには (a) libav を `--enable-encoder=mov_text` (および入力側の webvtt parser/decoder) 付きで再ビルドして PROVENANCE / THIRD_PARTY_NOTICES を更新し、(b) variant の `SUBTITLES` グループ解析 → 字幕レンディションを OPFS の `.vtt` に組み立て → device 入力として `-map 2:s:0 -c:s mov_text -metadata:s:s:0 language=...` を付与する、の 2 段階が必要。VP9/AV1 など他コーデックの再エンコードが必要な用途にも同じ前提が効く。
- **セグメント単位の破損検出 (13)**: 現状は ffmpeg のエラーに依存。必要になった時点で、セグメント取得経路に「demux して期待ストリームの有無を見る」検証を足す。
- **DASH の表現選択 (4)**: 能力差は解消済み (上記 5 の device 入力 + 自前トラック取得)。ffmpeg の `-mpd_video_idx` 相当の「表現だけ指定して残りは ffmpeg に任せる」最適化は行っていないが、結果は同等。

## 検証

- 単体: `npm test` (26 ファイル、`offscreen-streaming` / `offscreen-regressions` / `background` に今回の回帰テストを追加)
- 実機 E2E: `scripts/run_e2e.py` (direct / HLS / AES-128 / 認証付き HLS / OPFS / worker 再起動復元)、
  `scripts/e2e_large_output_test.py` (1.19 GB の成果物)、
  `scripts/e2e_live_recording_test.py` (ライブ録画 → 停止 → 部分ファイルの再生確認)、
  `scripts/e2e_dash_mux_test.py` (794 MB の DASH トラック mux)
