/**
 * mkv-subs.js
 * Matroska(MKV) からテキスト字幕トラック／音声トラック情報を取り出す純 JS 実装。
 * Electron 版では ffprobe / ffmpeg に頼っていた処理の Android 代替。
 *
 *  - File / Blob をストリームで先頭から走査し、映像・音声ブロックのペイロードは読み飛ばす
 *    （大きなブロックは stream を張り直してジャンプするので、全データを読まずに済む場合がある）
 *  - 対応: S_TEXT/UTF8, S_TEXT/ASCII, S_TEXT/ASS, S_TEXT/SSA, S_TEXT/WEBVTT
 *  - 画像字幕(PGS / VobSub 等)はトラック名のみ返し、字幕データは空（Electron 版と同じ挙動）
 *
 * 戻り値は Electron 版 `extract-subtitles` IPC と同じ形:
 *   { tracks:[{index,name,codec,subs:[{id,start,end,text}]}], audioTracks:[{index,name,language}], subtitles }
 */
(function (root) {
  'use strict';

  // ── EBML element IDs ──
  const ID = {
    Segment: 0x18538067, Info: 0x1549A966, TimecodeScale: 0x2AD7B1,
    Tracks: 0x1654AE6B, TrackEntry: 0xAE, TrackNumber: 0xD7, TrackType: 0x83,
    CodecID: 0x86, Language: 0x22B59C, LanguageBCP47: 0x22B59D, Name: 0x536E,
    DefaultDuration: 0x23E383,
    ContentEncodings: 0x6D80, ContentEncoding: 0x6240, ContentCompression: 0x5034,
    ContentCompAlgo: 0x4254, ContentCompSettings: 0x4255,
    Cluster: 0x1F43B675, Timecode: 0xE7, SimpleBlock: 0xA3,
    BlockGroup: 0xA0, Block: 0xA1, BlockDuration: 0x9B,
  };
  // 中身を順に読み進める（子要素へ降りる）マスター要素
  const DESCEND = new Set([
    ID.Segment, ID.Info, ID.Tracks, ID.TrackEntry, ID.ContentEncodings,
    ID.ContentEncoding, ID.ContentCompression, ID.Cluster, ID.BlockGroup,
  ]);
  // 値を読む要素
  const READ_LEAF = new Set([
    ID.TimecodeScale, ID.TrackNumber, ID.TrackType, ID.CodecID, ID.Language,
    ID.LanguageBCP47, ID.Name, ID.DefaultDuration, ID.ContentCompAlgo,
    ID.ContentCompSettings, ID.Timecode, ID.BlockDuration,
  ]);

  const TYPE_AUDIO = 2;
  const TYPE_SUBTITLE = 17;
  const TEXT_CODECS = new Set(['S_TEXT/UTF8', 'S_TEXT/ASCII', 'S_TEXT/ASS', 'S_TEXT/SSA', 'S_TEXT/WEBVTT']);

  // ffprobe の codec_name 相当（UI 表示・互換用）
  function ffCodecName(codecId) {
    switch (codecId) {
      case 'S_TEXT/UTF8': case 'S_TEXT/ASCII': return 'subrip';
      case 'S_TEXT/ASS': return 'ass';
      case 'S_TEXT/SSA': return 'ssa';
      case 'S_TEXT/WEBVTT': return 'webvtt';
      case 'S_HDMV/PGS': return 'hdmv_pgs_subtitle';
      case 'S_VOBSUB': return 'dvd_subtitle';
      case 'S_DVBSUB': return 'dvbsub';
      default: return (codecId || '').toLowerCase();
    }
  }

  // ─────────────────────────────────────────────
  // ストリームリーダー（スキップ時は必要に応じて stream を張り直す）
  // ─────────────────────────────────────────────
  class ByteReader {
    constructor(file, opts) {
      this.file = file;
      this.size = file.size;
      this.jump = (opts && opts.jumpThreshold) || (1 << 20); // これより遠い skip は stream を張り直す
      this.pos = 0;                 // 論理カーソル（絶対オフセット）
      this.buf = new Uint8Array(0); // 未消費バッファ
      this.bufStart = 0;            // buf[0] の絶対オフセット
      this.reader = null;
      this._open(0);
    }
    _open(offset) {
      if (this.reader) { try { this.reader.cancel(); } catch (_) {} }
      this.reader = this.file.slice(offset).stream().getReader();
      this.buf = new Uint8Array(0);
      this.bufStart = offset;
      this.pos = offset;
    }
    get end() { return this.bufStart + this.buf.length; }
    get remaining() { return this.size - this.pos; }

    /** 現在位置から n バイト読める状態にする。EOF で足りなければ false */
    async ensure(n) {
      if (this.end - this.pos >= n) return true;
      // 消費済み部分を捨てる
      if (this.pos > this.bufStart) {
        this.buf = this.buf.subarray(this.pos - this.bufStart);
        this.bufStart = this.pos;
      }
      while (this.end - this.pos < n) {
        if (this.end >= this.size) return false;
        const { value, done } = await this.reader.read();
        if (done) return false;
        if (this.buf.length === 0) {
          this.buf = value;
        } else {
          const merged = new Uint8Array(this.buf.length + value.length);
          merged.set(this.buf, 0);
          merged.set(value, this.buf.length);
          this.buf = merged;
        }
      }
      return true;
    }
    /** 現在位置の先頭 n バイト（ensure 済みであること） */
    peek(n) {
      const o = this.pos - this.bufStart;
      return this.buf.subarray(o, o + n);
    }
    /** target（絶対オフセット、>= pos）へ移動 */
    async skipTo(target) {
      if (target >= this.size) { this.pos = this.size; return; }
      if (target <= this.end) { this.pos = target; return; }
      if (target - this.end > this.jump) {
        this._open(target);           // 遠いので張り直し
      } else {
        await this.ensure(target - this.pos); // 近いので読み捨て
        this.pos = target;
      }
    }
    close() { if (this.reader) { try { this.reader.cancel(); } catch (_) {} this.reader = null; } }
  }

  // ─────────────────────────────────────────────
  // EBML プリミティブ
  // ─────────────────────────────────────────────
  /** @returns {{id:number,len:number}|null} マーカービット込みの ID */
  function readId(b, o) {
    const first = b[o];
    if (first === 0) return null;
    let len = 1, mask = 0x80;
    while (!(first & mask)) { len++; mask >>= 1; }
    if (len > 4) return null;
    let id = 0;
    for (let i = 0; i < len; i++) id = id * 256 + b[o + i];
    return { id, len };
  }
  /** @returns {{size:number,len:number}|null} size=-1 は不定長 */
  function readSize(b, o) {
    const first = b[o];
    if (first === 0) return null;
    let len = 1, mask = 0x80;
    while (!(first & mask)) { len++; mask >>= 1; }
    let val = first & (mask - 1);
    let allOnes = val === mask - 1;
    for (let i = 1; i < len; i++) {
      val = val * 256 + b[o + i];
      if (b[o + i] !== 0xFF) allOnes = false;
    }
    return { size: allOnes ? -1 : val, len };
  }
  function readUInt(bytes) {
    let v = 0;
    for (let i = 0; i < bytes.length; i++) v = v * 256 + bytes[i];
    return v;
  }
  function readStr(bytes) {
    let end = bytes.length;
    while (end > 0 && bytes[end - 1] === 0) end--; // 末尾 NUL 除去
    return new TextDecoder('utf-8').decode(bytes.subarray(0, end));
  }

  // ─────────────────────────────────────────────
  // 字幕テキスト整形
  // ─────────────────────────────────────────────
  const utf8 = new TextDecoder('utf-8');

  function cleanText(s) {
    return s
      .replace(/\r\n?/g, '\n')
      .replace(/<[^>]+>/g, '')
      .replace(/\{[^}]*\}/g, '')
      .replace(/\\[Nn]/g, '\n')
      .replace(/\\h/g, ' ')
      .trim();
  }

  function decodeCue(track, bytes) {
    const raw = utf8.decode(bytes);
    if (track.codecId === 'S_TEXT/ASS' || track.codecId === 'S_TEXT/SSA') {
      // ReadOrder,Layer,Style,Name,MarginL,MarginR,MarginV,Effect,Text（Text 内のカンマは保持）
      let idx = -1;
      for (let i = 0; i < 8; i++) {
        idx = raw.indexOf(',', idx + 1);
        if (idx < 0) return '';
      }
      return cleanText(raw.slice(idx + 1));
    }
    return cleanText(raw);
  }

  // ─────────────────────────────────────────────
  // ブロックデータの圧縮解除（ContentCompression）
  // ─────────────────────────────────────────────
  async function inflate(bytes) {
    const ds = new DecompressionStream('deflate');
    const stream = new Blob([bytes]).stream().pipeThrough(ds);
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }
  async function decodeBlockData(track, bytes) {
    if (track.compAlgo === 0) {                 // zlib
      try { return await inflate(bytes); } catch (_) { return bytes; }
    }
    if (track.compAlgo === 3 && track.compSettings) { // header stripping
      const merged = new Uint8Array(track.compSettings.length + bytes.length);
      merged.set(track.compSettings, 0);
      merged.set(bytes, track.compSettings.length);
      return merged;
    }
    return bytes;
  }

  // ─────────────────────────────────────────────
  // 結果組み立て（走査結果 → UI 用データ）。JS 走査(extract)とネイティブ走査(fromNative)で共通
  // ─────────────────────────────────────────────
  function assemble(tracks, rawCues, timecodeScale) {
    const subTracks = tracks.filter(t => t.type === TYPE_SUBTITLE);
    const audioTrackList = tracks.filter(t => t.type === TYPE_AUDIO);

    const outTracks = [];
    for (let i = 0; i < subTracks.length; i++) {
      const t = subTracks[i];
      const label = t.name || (t.lang && t.lang !== 'und' ? t.lang : '') || `Subtitle ${i + 1}`;
      let subs = [];
      const cues = rawCues.get(t.number);
      if (cues) {
        const defSec = t.defDur ? t.defDur / 1e9 : 0;
        const list = cues.map(c => {
          const dur = c.durTicks != null ? c.durTicks * timecodeScale / 1e9 : (defSec || 3);
          return { start: c.start, end: c.start + dur, text: decodeCue(t, c.bytes) };
        }).filter(c => c.text && isFinite(c.start) && isFinite(c.end));
        list.sort((a, b) => a.start - b.start);
        subs = list.map((c, k) => ({ id: k, start: c.start, end: c.end, text: c.text }));
      }
      outTracks.push({ index: t.number, name: label, codec: ffCodecName(t.codecId), subs });
    }

    const audioTracks = audioTrackList.map((t, i) => ({
      index: t.number,
      name: t.name || (t.lang && t.lang !== 'und' ? t.lang : '') || `Audio ${i + 1}`,
      language: t.lang && t.lang !== 'und' ? t.lang : '',
    }));

    return { tracks: outTracks, audioTracks, subtitles: outTracks[0] ? outTracks[0].subs : [] };
  }

  function b64ToBytes(b64) {
    const bin = atob(b64 || '');
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  /**
   * ネイティブ(MkvScanner.java)が走査した「生のキュー」から結果を組み立てる。extract() と同じ形式を返す。
   * @param {{timecodeScale:number, tracks:Array, cues:Array}} raw
   */
  async function fromNative(raw) {
    const timecodeScale = raw.timecodeScale || 1000000;
    const tracks = (raw.tracks || []).map(t => ({
      number: t.number, type: t.type, codecId: t.codecId || '', lang: t.lang || '', name: t.name || '',
      defDur: t.defDur || 0,
      compAlgo: t.compAlgo == null ? -1 : t.compAlgo,
      compSettings: t.compSettings ? b64ToBytes(t.compSettings) : null,
    }));
    const byNum = new Map(tracks.map(t => [t.number, t]));
    const rawCues = new Map();
    for (const t of tracks) if (t.type === TYPE_SUBTITLE && TEXT_CODECS.has(t.codecId)) rawCues.set(t.number, []);
    for (const c of raw.cues || []) {
      const track = byNum.get(c.track);
      const list = track && rawCues.get(track.number);
      if (!list) continue;
      const bytes = await decodeBlockData(track, b64ToBytes(c.data));
      list.push({ track, start: c.ticks * timecodeScale / 1e9, durTicks: c.dur >= 0 ? c.dur : null, bytes });
    }
    return assemble(tracks, rawCues, timecodeScale);
  }

  // ─────────────────────────────────────────────
  // メイン
  // ─────────────────────────────────────────────
  /**
   * @param {Blob} file
   * @param {{onProgress?:(ratio:number)=>void, signal?:{aborted:boolean}, jumpThreshold?:number}} [opts]
   */
  async function extract(file, opts) {
    opts = opts || {};
    const r = new ByteReader(file, opts);
    const tracks = [];            // TrackEntry 情報
    let cur = null;
    let timecodeScale = 1000000;  // ns / tick（既定 1ms）
    let clusterTime = 0;
    let tracksByNum = null;       // 字幕トラック番号 → track
    const rawCues = new Map();    // track.number → [{start,dur,bytes}]
    let pending = null;           // BlockGroup 内で BlockDuration 待ちのキュー
    let groupDur = null;
    let lastProgress = 0;

    const buildTable = () => {
      tracksByNum = new Map();
      for (const t of tracks) {
        if (t.type === TYPE_SUBTITLE && TEXT_CODECS.has(t.codecId)) {
          tracksByNum.set(t.number, t);
          rawCues.set(t.number, []);
        }
      }
    };
    const flush = () => {
      if (pending) {
        rawCues.get(pending.track.number).push(pending);
        pending = null;
      }
    };
    const addCue = (track, relTime, dur, bytes) => {
      const ticks = clusterTime + relTime;
      return { track, start: ticks * timecodeScale / 1e9, durTicks: dur, bytes };
    };

    try {
      while (await r.ensure(1)) {
        if (opts.signal && opts.signal.aborted) throw new Error('aborted');

        const elemStart = r.pos;
        if (pending && elemStart >= pending.groupEnd) flush();

        // ヘッダ（最大 4 + 8 バイト）
        const hdrNeed = Math.min(12, r.remaining);
        if (!(await r.ensure(hdrNeed))) break;
        const hb = r.peek(hdrNeed);
        const idv = readId(hb, 0);
        if (!idv) break;                       // 壊れている
        if (idv.len >= hdrNeed) break;
        const szv = readSize(hb, idv.len);
        if (!szv || idv.len + szv.len > hdrNeed) break;
        const hdrLen = idv.len + szv.len;
        const id = idv.id, size = szv.size;
        r.pos += hdrLen;
        const dataStart = r.pos;

        if (id === ID.Cluster) {
          flush();
          if (!tracksByNum) buildTable();
          clusterTime = 0;
        }
        if (id === ID.BlockGroup) {
          flush();
          groupDur = null;
          r._groupEnd = size >= 0 ? dataStart + size : Infinity;
        }

        if (DESCEND.has(id)) {
          if (id === ID.TrackEntry) {
            cur = { number: 0, type: 0, codecId: '', lang: '', name: '', defDur: 0, compAlgo: -1, compSettings: null };
            tracks.push(cur);
          }
          continue; // 子要素は同じループでそのまま読み進める
        }

        if (size < 0) break; // 不定長の非マスター要素は扱えない

        // ── ブロック本体 ──
        if (id === ID.SimpleBlock || id === ID.Block) {
          if (!tracksByNum) buildTable();
          const peekN = Math.min(size, 16);
          if (!(await r.ensure(peekN))) break;
          const pb = r.peek(peekN);
          const tv = readSize(pb, 0); // トラック番号は vint（マーカー除去）
          let handled = false;
          if (tv && tv.len + 3 <= peekN) {
            const track = tracksByNum.get(tv.size);
            if (track) {
              const rel = (pb[tv.len] << 8) | pb[tv.len + 1];
              const relTime = rel & 0x8000 ? rel - 0x10000 : rel;
              const flags = pb[tv.len + 2];
              const lacing = (flags >> 1) & 3;
              if (lacing === 0) {
                if (!(await r.ensure(size))) break;
                let payload = r.peek(size).slice(tv.len + 3); // コピー
                payload = await decodeBlockData(track, payload);
                const cue = addCue(track, relTime, null, payload);
                if (id === ID.Block) {
                  cue.groupEnd = r._groupEnd === undefined ? Infinity : r._groupEnd;
                  cue.durTicks = groupDur;
                  pending = cue;
                } else {
                  rawCues.get(track.number).push(cue);
                }
                handled = true;
              }
            }
          }
          await r.skipTo(dataStart + size);
          void handled;
        } else if (READ_LEAF.has(id) && size <= (1 << 20)) {
          if (!(await r.ensure(size))) break;
          const bytes = r.peek(size);
          switch (id) {
            case ID.TimecodeScale:    timecodeScale = readUInt(bytes) || 1000000; break;
            case ID.Timecode:         clusterTime = readUInt(bytes); break;
            case ID.BlockDuration:
              groupDur = readUInt(bytes);
              if (pending) pending.durTicks = groupDur;
              break;
            case ID.TrackNumber:      if (cur) cur.number = readUInt(bytes); break;
            case ID.TrackType:        if (cur) cur.type = readUInt(bytes); break;
            case ID.CodecID:          if (cur) cur.codecId = readStr(bytes); break;
            case ID.Language:         if (cur && !cur.langBcp) cur.lang = readStr(bytes); break;
            case ID.LanguageBCP47:    if (cur) { cur.lang = readStr(bytes); cur.langBcp = true; } break;
            case ID.Name:             if (cur) cur.name = readStr(bytes); break;
            case ID.DefaultDuration:  if (cur) cur.defDur = readUInt(bytes); break;
            case ID.ContentCompAlgo:  if (cur) cur.compAlgo = readUInt(bytes); break;
            case ID.ContentCompSettings: if (cur) cur.compSettings = bytes.slice(); break;
          }
          r.pos = dataStart + size;
        } else {
          await r.skipTo(dataStart + size); // Cues / SeekHead / Tags / Attachments / Void など
        }

        if (opts.onProgress) {
          const ratio = r.pos / r.size;
          if (ratio - lastProgress >= 0.01) { lastProgress = ratio; opts.onProgress(ratio); }
        }
      }
      flush();
    } finally {
      r.close();
    }
    if (opts.onProgress) opts.onProgress(1);

    return assemble(tracks, rawCues, timecodeScale);
  }

  const api = { extract, fromNative };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.MkvSubs = api;
})(typeof self !== 'undefined' ? self : this);
