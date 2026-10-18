package __APP_ID__;

import java.io.IOException;
import java.nio.ByteBuffer;
import java.nio.channels.FileChannel;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.HashSet;
import java.util.List;
import java.util.Set;

/**
 * Matroska(MKV/WebM) からテキスト字幕のキューを取り出す高速スキャナ。
 *
 * www/mkv-subs.js の extract() と同じ走査を、ネイティブで行う版。
 * JS 版はファイル全体をブリッジ越し(base64)で読むため大きな動画で非常に遅かったが、
 * こちらは端末内で直接読み、大きな映像ブロックは読まずに飛ばす（1MB 以上離れるときは読み捨てずにシーク）。
 * 返すのは「生のキュー」だけで、テキスト整形（ASS 解析・圧縮解除）は JS 側(MkvSubs.fromNative)が行う。
 *
 * このファイルは scripts/patch-android.js によって android/ 配下へコピーされる。
 */
final class MkvScanner {

    static final class Track {
        long number;
        long type;
        String codecId = "";
        String lang = "";
        boolean langBcp = false;
        String name = "";
        long defDur = 0;
        long compAlgo = -1;
        byte[] compSettings = null;
    }

    static final class Cue {
        long track;
        long ticks;          // クラスタ時刻 + ブロック相対時刻（TimecodeScale 単位）
        long dur = -1;       // BlockDuration（無ければ -1）
        byte[] data;
    }

    static final class Result {
        long timecodeScale = 1000000;
        final List<Track> tracks = new ArrayList<>();
        final List<Cue> cues = new ArrayList<>();
    }

    interface Cancel {
        boolean isCancelled();
    }

    // EBML element IDs（www/mkv-subs.js と同じ）
    private static final long SEGMENT = 0x18538067L, INFO = 0x1549A966L, TIMECODE_SCALE = 0x2AD7B1L;
    private static final long TRACKS = 0x1654AE6BL, TRACK_ENTRY = 0xAEL, TRACK_NUMBER = 0xD7L, TRACK_TYPE = 0x83L;
    private static final long CODEC_ID = 0x86L, LANGUAGE = 0x22B59CL, LANGUAGE_BCP47 = 0x22B59DL, NAME = 0x536EL;
    private static final long DEFAULT_DURATION = 0x23E383L;
    private static final long CONTENT_ENCODINGS = 0x6D80L, CONTENT_ENCODING = 0x6240L, CONTENT_COMPRESSION = 0x5034L;
    private static final long COMP_ALGO = 0x4254L, COMP_SETTINGS = 0x4255L;
    private static final long CLUSTER = 0x1F43B675L, TIMECODE = 0xE7L, SIMPLE_BLOCK = 0xA3L;
    private static final long BLOCK_GROUP = 0xA0L, BLOCK = 0xA1L, BLOCK_DURATION = 0x9BL;

    private static final long TYPE_SUBTITLE = 17;
    private static final int MAX_PAYLOAD = 1 << 20;
    private static final int MAX_CUES = 300000;
    private static final int FAR_JUMP = 64 * 1024;   // これ以上離れた位置へ飛ぶときは、小さな読み込みだけで済ませる

    private final FileChannel ch;
    private final long size;
    private final Cancel cancel;

    private final byte[] buf = new byte[1 << 20];
    private long bufStart = 0;
    private int bufLen = 0;
    private long pos = 0;

    MkvScanner(FileChannel ch, long size, Cancel cancel) {
        this.ch = ch;
        this.size = size;
        this.cancel = cancel;
    }

    private static boolean isTextCodec(String c) {
        return "S_TEXT/UTF8".equals(c) || "S_TEXT/ASCII".equals(c) || "S_TEXT/ASS".equals(c)
            || "S_TEXT/SSA".equals(c) || "S_TEXT/WEBVTT".equals(c);
    }

    /** pos から n バイト（n <= 1MB）をバッファに載せる。ファイル末尾で足りなければ false */
    private boolean ensure(int n) throws IOException {
        long bufEnd = bufStart + bufLen;
        if (pos >= bufStart && pos + n <= bufEnd) return true;
        if (pos + n > size) return false;
        int want = (pos >= bufEnd && pos - bufEnd > FAR_JUMP) ? FAR_JUMP : buf.length;
        if (want < n) want = n;
        if (want > buf.length) want = buf.length;
        ByteBuffer bb = ByteBuffer.wrap(buf, 0, want);
        while (bb.hasRemaining()) {
            int r = ch.read(bb, pos + bb.position());
            if (r <= 0) break;
        }
        bufStart = pos;
        bufLen = bb.position();
        return bufLen >= n;
    }

    private long readUInt(int off, int len) {
        long v = 0;
        for (int i = 0; i < len; i++) v = (v << 8) | (buf[off + i] & 0xFF);
        return v;
    }

    private String readStr(int off, int len) {
        int end = len;
        while (end > 0 && buf[off + end - 1] == 0) end--;   // 末尾 NUL 除去
        return new String(buf, off, end, StandardCharsets.UTF_8);
    }

    Result scan() throws IOException {
        final Result res = new Result();
        Track cur = null;
        Set<Long> textNums = null;       // テキスト字幕のトラック番号
        long clusterTime = 0;
        Cue pending = null;              // BlockGroup 内で BlockDuration 待ちのキュー
        long pendingEnd = Long.MAX_VALUE;
        long groupDur = -1;
        long groupEnd = Long.MAX_VALUE;

        pos = 0;
        while (pos < size) {
            if (cancel != null && cancel.isCancelled()) throw new IOException("cancelled");

            final long elemStart = pos;
            if (pending != null && elemStart >= pendingEnd) {
                res.cues.add(pending);
                pending = null;
            }

            // ── 要素ヘッダ（ID 最大 4 バイト + サイズ 最大 8 バイト） ──
            int hdrNeed = (int) Math.min(12, size - pos);
            if (!ensure(hdrNeed)) break;
            int o = (int) (pos - bufStart);
            int b0 = buf[o] & 0xFF;
            if (b0 == 0) break;                                   // 壊れている
            int idLen = Integer.numberOfLeadingZeros(b0) - 23;
            if (idLen > 4 || idLen >= hdrNeed) break;
            long id = readUInt(o, idLen);
            int s0 = buf[o + idLen] & 0xFF;
            if (s0 == 0) break;
            int szLen = Integer.numberOfLeadingZeros(s0) - 23;
            if (szLen > 8 || idLen + szLen > hdrNeed) break;
            int sMask = (0x80 >> (szLen - 1)) - 1;
            long val = s0 & sMask;
            boolean allOnes = (val == sMask);
            for (int i = 1; i < szLen; i++) {
                int bb = buf[o + idLen + i] & 0xFF;
                val = (val << 8) | bb;
                if (bb != 0xFF) allOnes = false;
            }
            final long elSize = allOnes ? -1 : val;               // -1 は不定長
            pos += idLen + szLen;
            final long dataStart = pos;

            // ── 子要素へ降りるマスター要素 ──
            if (id == CLUSTER) {
                if (pending != null) { res.cues.add(pending); pending = null; }
                if (textNums == null) textNums = buildTable(res);
                clusterTime = 0;
                continue;
            }
            if (id == BLOCK_GROUP) {
                if (pending != null) { res.cues.add(pending); pending = null; }
                groupDur = -1;
                groupEnd = elSize >= 0 ? dataStart + elSize : Long.MAX_VALUE;
                continue;
            }
            if (id == TRACK_ENTRY) {
                cur = new Track();
                res.tracks.add(cur);
                continue;
            }
            if (id == SEGMENT || id == INFO || id == TRACKS || id == CONTENT_ENCODINGS
                || id == CONTENT_ENCODING || id == CONTENT_COMPRESSION) {
                continue;
            }

            if (elSize < 0) break;                                // 不定長の非マスター要素は扱えない

            // ── ブロック本体 ──
            if (id == SIMPLE_BLOCK || id == BLOCK) {
                if (textNums == null) textNums = buildTable(res);
                if (elSize >= 4 && !textNums.isEmpty()) {
                    int peekN = (int) Math.min(elSize, 16);
                    if (!ensure(peekN)) break;
                    o = (int) (pos - bufStart);
                    int t0 = buf[o] & 0xFF;
                    if (t0 != 0) {
                        int tLen = Integer.numberOfLeadingZeros(t0) - 23;
                        if (tLen <= 8 && tLen + 3 <= peekN) {
                            int tMask = (0x80 >> (tLen - 1)) - 1;
                            long trackNum = t0 & tMask;
                            for (int i = 1; i < tLen; i++) trackNum = (trackNum << 8) | (buf[o + i] & 0xFF);
                            if (textNums.contains(trackNum)) {
                                int rel = (short) (((buf[o + tLen] & 0xFF) << 8) | (buf[o + tLen + 1] & 0xFF));
                                int flags = buf[o + tLen + 2] & 0xFF;
                                int lacing = (flags >> 1) & 3;
                                if (lacing == 0 && elSize <= MAX_PAYLOAD && elSize >= tLen + 3
                                    && res.cues.size() < MAX_CUES) {
                                    if (!ensure((int) elSize)) break;
                                    o = (int) (pos - bufStart);
                                    Cue c = new Cue();
                                    c.track = trackNum;
                                    c.ticks = clusterTime + rel;
                                    c.data = Arrays.copyOfRange(buf, o + tLen + 3, o + (int) elSize);
                                    if (id == BLOCK) {
                                        c.dur = groupDur;
                                        pending = c;
                                        pendingEnd = groupEnd;
                                    } else {
                                        res.cues.add(c);
                                    }
                                }
                            }
                        }
                    }
                }
                pos = dataStart + elSize;                          // 本体は読まずに飛ばす
                continue;
            }

            // ── 値を読む要素 ──
            if (isLeaf(id) && elSize <= MAX_PAYLOAD) {
                if (!ensure((int) elSize)) break;
                o = (int) (pos - bufStart);
                int n = (int) elSize;
                if (id == TIMECODE_SCALE) { long v = readUInt(o, n); res.timecodeScale = v > 0 ? v : 1000000; }
                else if (id == TIMECODE) clusterTime = readUInt(o, n);
                else if (id == BLOCK_DURATION) {
                    groupDur = readUInt(o, n);
                    if (pending != null) pending.dur = groupDur;
                }
                else if (cur != null) {
                    if (id == TRACK_NUMBER) cur.number = readUInt(o, n);
                    else if (id == TRACK_TYPE) cur.type = readUInt(o, n);
                    else if (id == CODEC_ID) cur.codecId = readStr(o, n);
                    else if (id == LANGUAGE) { if (!cur.langBcp) cur.lang = readStr(o, n); }
                    else if (id == LANGUAGE_BCP47) { cur.lang = readStr(o, n); cur.langBcp = true; }
                    else if (id == NAME) cur.name = readStr(o, n);
                    else if (id == DEFAULT_DURATION) cur.defDur = readUInt(o, n);
                    else if (id == COMP_ALGO) cur.compAlgo = readUInt(o, n);
                    else if (id == COMP_SETTINGS) cur.compSettings = Arrays.copyOfRange(buf, o, o + n);
                }
            }
            pos = dataStart + elSize;                              // Cues / SeekHead / Tags / Attachments / Void など
        }
        if (pending != null) res.cues.add(pending);
        return res;
    }

    private static boolean isLeaf(long id) {
        return id == TIMECODE_SCALE || id == TRACK_NUMBER || id == TRACK_TYPE || id == CODEC_ID
            || id == LANGUAGE || id == LANGUAGE_BCP47 || id == NAME || id == DEFAULT_DURATION
            || id == COMP_ALGO || id == COMP_SETTINGS || id == TIMECODE || id == BLOCK_DURATION;
    }

    private static Set<Long> buildTable(Result res) {
        Set<Long> nums = new HashSet<>();
        for (Track t : res.tracks) {
            if (t.type == TYPE_SUBTITLE && isTextCodec(t.codecId)) nums.add(t.number);
        }
        return nums;
    }
}
