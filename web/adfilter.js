/*!
 * AdFilter (JavaScript port) —— 与 Android 端 core/AdFilter.java 同一套规则。
 *
 * 规则来自**真实清单**的实测, 不是猜的:
 *  ① SCTE-35 / CUE 广告块: CUE-OUT 起到 CUE-IN 止整段丢; 只有 CUE-OUT 没有 CUE-IN 时靠两道安全阀
 *     (见 ENDLIST 复位 + 一个块最多丢 90 行), 免得把后面所有正片删光;
 *  ② 外挂字幕/闭路字幕组 + STREAM-INF 里的 SUBTITLES 引用(只清被删掉的那个组);
 *  ③ 预览图/贴片轨道(IMAGE-STREAM-INF);
 *  ④ 广告分片: 主机第一段是广告标签 / 路径里整段是广告词 / 文件名是 ad_ 这类命名前缀(不做任意子串匹配,
 *     曾经因为 "ad." 子串把正常分片 7LHrS4ad.ts 删掉过);
 *  ⑤ 主目录规则: 正片一个目录、插入广告块另一个目录。实测广告占比 0.7%~2.5% ——
 *     异目录 ≤10% 直接删; 10%~25% 才要求"每一块都被 DISC/清单头尾夹住";
 *  ⑥ 短插播块: 广告被剪成一段插在正片中间、被 DISC 夹住的短块(段名和正片一样, 目录规则看不见)。
 *     判据: DISC 夹持 + ≤60 秒 + ≤8% + 位置守卫 + 三道总闸(命中≤3 / DISC块≤8 / 删段≤15%)。
 */
(function (root) {
  'use strict';

  var AD_LABEL = ['ad','ads','adv','advert','advertise','adservice','adserver','preroll','pre-roll'];
  // 2026-10 实测补: 用户报"所有源都插棋牌类视频广告" —— 这类广告块目录常带博彩词。
  // 一律**整段精确相等**才命中("qp" 不会误伤 "qpxyz123" 这种随机目录名)。
  var AD_PATH_SEG = ['ad','ads','adv','advert','advertise','adservice','adserver','preroll','pre-roll',
    'qp','qipai','qipa','bocai','caipiao','casino','macau','aomen','xinpujing','pujing','leyu',
    'guanggao','gg','adjump','ad-jump','adinsert','ad-insert'];
  var CUE_MAX = 90;                  // 一个 CUE 块最多丢多少行
  var BLOCK_MAX_SEC = 60;            // 短插播块时长上限
  var BLOCK_MAX_PCT = 8;             // 短插播块占全片比例上限
  var DOM_MIN_PCT = 60;              // 主目录占比下限
  var DOM_MAX_ODD_PCT = 25;          // 异目录占比上限
  var DOM_FREE_ODD_PCT = 10;         // 异目录 ≤ 这个比例时直接删

  var dropped = 0, note = '', lastStats = null;

  function reset() { dropped = 0; note = ''; }

  function attr(line, key) {
    var i = line.indexOf(key + '="');
    if (i < 0) return null;
    var b = i + key.length + 2, e = line.indexOf('"', b);
    return e > b ? line.substring(b, e) : null;
  }

  function looksAd(url) {
    try {
      var u = String(url).toLowerCase();
      var noQuery = u.split('?')[0];
      var host = '', path = noQuery;
      if (noQuery.indexOf('http') === 0) {
        var rest = noQuery.split('://')[1] || '';
        var slash = rest.indexOf('/');
        host = slash < 0 ? rest : rest.substring(0, slash);
        path = slash < 0 ? '/' : rest.substring(slash);
        var colon = host.indexOf(':');
        if (colon > 0) host = host.substring(0, colon);
      }
      var labels = host.split('.');
      if (labels.length && labels[0] && AD_LABEL.indexOf(labels[0]) >= 0) return true;
      var parts = path.split('/');
      for (var i = 0; i < parts.length - 1; i++) {
        if (parts[i] && AD_PATH_SEG.indexOf(parts[i]) >= 0) return true;
      }
      var file = parts.length ? parts[parts.length - 1] : '';
      return /^(ad_|ad-|ads_|ads-|advert_|preroll_|guanggao)/.test(file);
    } catch (e) { return false; }
  }

  function dirOf(url) {
    var u = String(url).split('?')[0].replace(/^https?:\/\//, '');
    var slash = u.lastIndexOf('/');
    return slash <= 0 ? '' : u.substring(0, slash);
  }

  /** ⑤ 主目录规则(按异目录占比分档) */
  function byDominantDir(lines, stats) {
    var dirCount = {}, total = 0;
    for (var i = 0; i < lines.length; i++) {
      var t = lines[i].trim();
      if (!t || t.charAt(0) === '#') continue;
      var d = dirOf(t);
      if (!d) continue;
      dirCount[d] = (dirCount[d] || 0) + 1;
      total++;
    }
    var keys = Object.keys(dirCount);
    if (total < 8 || keys.length < 2) return null;
    var dom = null, domN = 0;
    keys.forEach(function (k) { if (dirCount[k] > domN) { domN = dirCount[k]; dom = k; } });
    if (dom === null || domN * 100 / total < DOM_MIN_PCT) return null;
    var oddN = total - domN;
    if (oddN * 100 / total > DOM_MAX_ODD_PCT) return null;

    // 把异目录段按"被主目录分片隔断"分块
    var runs = [], afterContent = true;
    for (var j = 0; j < lines.length; j++) {
      var s = lines[j].trim();
      if (!s || s.charAt(0) === '#') continue;
      var dd = dirOf(s);
      var odd = dd && dd !== dom;
      if (!odd) { afterContent = true; continue; }
      if (afterContent || !runs.length) runs.push([j, j]);
      else runs[runs.length - 1][1] = j;
      afterContent = false;
    }
    if (!runs.length) return null;
    var oddTotal = 0;
    runs.forEach(function (r) { oddTotal += (r[1] - r[0]); });
    if (oddTotal < 2) return null;
    var minority = oddN * 100 / total <= DOM_FREE_ODD_PCT;
    if (!minority) {
      if (runs.length > 8) return null;
      for (var k = 0; k < runs.length; k++) if (!bracketed(lines, runs[k][0], runs[k][1])) return null;
    }
    var kill = {}, cntDir = 0;
    runs.forEach(function (r) {
      for (var x = r[0]; x <= r[1]; x++) {
        var tx = lines[x].trim();
        if (!tx || tx.charAt(0) === '#') continue;      // 只数真正的分片行(Java 端就是这么数的)
        kill[x] = 1; cntDir++;
      }
    });
    stats.nDir = cntDir;
    return kill;
  }

  function discNear(lines, start, step) {
    var seen = 0;
    for (var i = start; i >= 0 && i < lines.length && seen < 5; i += step) {
      var t = lines[i].trim();
      if (!t || t.indexOf('#EXTINF') === 0) continue;
      seen++;
      if (t.indexOf('#EXT-X-DISCONTINUITY') === 0 || t.indexOf('#EXT-X-ENDLIST') === 0) return true;
      if (t.charAt(0) !== '#') return false;
      if (t.indexOf('#EXT-X-KEY') === 0 || t.indexOf('#EXT-X-MAP') === 0) continue;
    }
    return false;
  }
  function bracketed(lines, from, to) {
    return discNear(lines, from - 1, -1) && discNear(lines, to + 1, 1);
  }

  /** ⑥ 短插播块 */
  function byShortBlocks(lines, stats) {
    var discAt = [], total = 0, curDur = 0;
    var dur = [], isSeg = [];
    for (var i = 0; i < lines.length; i++) {
      var t = lines[i].trim();
      if (t.indexOf('#EXT-X-DISCONTINUITY') === 0) { discAt.push(i); continue; }
      if (t.indexOf('#EXTINF') === 0) {
        var c = t.indexOf(':'), comma = t.indexOf(',');
        if (c > 0 && comma > c) { var v = parseFloat(t.substring(c + 1, comma)); curDur = isNaN(v) ? 0 : v; }
        continue;
      }
      if (t && t.charAt(0) !== '#') { isSeg[i] = true; dur[i] = curDur; total += curDur; curDur = 0; }
    }
    if (total < 8 * 60 || discAt.length < 2) return null;
    var upto = [], acc = 0;
    for (var j = 0; j < lines.length; j++) { upto[j] = acc; if (isSeg[j]) acc += dur[j]; }
    upto[lines.length] = acc;

    var cand = [], blocks = 0;
    for (var k = 0; k < discAt.length - 1; k++) {
      var a = discAt[k], b = discAt[k + 1], d = 0, n = 0, first = -1, last = -1;
      for (var m = a + 1; m < b; m++) {
        if (!isSeg[m]) continue;
        d += dur[m]; n++; if (first < 0) first = m; last = m;
      }
      if (!n) continue;
      blocks++;
      var midstory = upto[a] > 90 && upto[b] < total - 60;
      if (n >= 2 && d > 0 && d <= BLOCK_MAX_SEC && (d * 100 / total) <= BLOCK_MAX_PCT && midstory) cand.push([first, last]);
    }
    if (!cand.length || blocks > 8 || cand.length > 3) return null;
    var candSegs = 0;
    cand.forEach(function (r) { candSegs += (r[1] - r[0]); });
    var totalSegs = isSeg.filter(Boolean).length;
    if (!totalSegs || candSegs * 100 / totalSegs > 15) return null;
    var kill = {}, cntBlk = 0;
    cand.forEach(function (r) {
      for (var x = r[0]; x <= r[1]; x++) {
        if (!isSeg[x]) continue;                        // 只数分片行
        kill[x] = 1; cntBlk++;
      }
    });
    stats.nBlk = cntBlk;
    return kill;
  }

  /** 主入口: 返回 { text, dropped, note } */
  /**
   * 明流插播块: 正片是加密流时, 把"连续 + 时长 ≤90 秒 + 占比 ≤25%"的 METHOD=NONE 分片段整块删掉。
   * 只删**分片行**, 标签行(#EXT-X-KEY / #EXT-X-DISCONTINUITY)全部保留 ——
   * 保留 KEY 的先后顺序, 后面的正片才会用正确的钥匙解密。
   * 返回: 要删的行下标集合(没有就返回 null)。
   */
  function byNoneKeyRuns(lines, stats) {
    var segIdx = [], segKey = [], segDur = [], curKey = null, curDur = 0, anyEnc = false;
    for (var i = 0; i < lines.length; i++) {
      var t = lines[i].trim();
      if (t.indexOf('#EXT-X-KEY') === 0) {
        curKey = t;
        if (t.indexOf('METHOD=NONE') < 0) anyEnc = true;      // 有非 NONE 的钥匙 = 加密流
      } else if (t.indexOf('#EXTINF') === 0) {
        var c = t.indexOf(':'), e = t.indexOf(',', c + 1);
        curDur = parseFloat(e < 0 ? t.slice(c + 1) : t.slice(c + 1, e)) || 0;
      } else if (t && t.charAt(0) !== '#') {
        segIdx.push(i); segKey.push(curKey || ''); segDur.push(curDur); curDur = 0;
      }
    }
    var total = segIdx.length;
    if (!anyEnc || total < 8) return null;                    // 整条没加密: 无从区分, 不动
    var kill = null, i2 = 0;
    while (i2 < total) {
      var j = i2;
      while (j + 1 < total && segKey[j + 1] === segKey[i2]) j++;
      var k = segKey[i2], len = j - i2 + 1, sum = 0;
      for (var x = i2; x <= j; x++) sum += segDur[x];
      if (k && k.indexOf('METHOD=NONE') >= 0 && sum <= 90 && len * 100 / total <= 25) {
        if (!kill) kill = {};
        for (var y = i2; y <= j; y++) { kill[segIdx[y]] = 1; stats.nKeyBlk++; }
      }
      i2 = j + 1;
    }
    return kill;
  }

  function filter(text, base) {
    if (!text) return { text: text, dropped: 0, note: '' };
    var lines = text.split(/\r?\n/);
    var out = [], stats = { nSeg: 0, nCue: 0, nSub: 0, nImg: 0, nDir: 0, nBlk: 0, nKeyBlk: 0 };
    var inCue = false, cueLines = 0, subGroup = null;
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i], t = line.trim();
      if (t.indexOf('#EXT-X-CUE-OUT') === 0 || t.indexOf('#EXT-X-SCTE35') === 0
          || t.indexOf('#EXT-OATCLS-SCTE35') === 0 || t.indexOf('#EXT-X-ASSET') === 0
          || t.indexOf('#EXT-X-AD') === 0) { inCue = true; stats.nCue++; continue; }
      if (t.indexOf('#EXT-X-CUE-IN') === 0) { inCue = false; cueLines = 0; continue; }
      if (t.indexOf('#EXT-X-ENDLIST') === 0) { inCue = false; cueLines = 0; }
      if (inCue) { cueLines++; if (cueLines > CUE_MAX) inCue = false; else continue; }
      if (t.indexOf('#EXT-X-MEDIA:') === 0 && (t.indexOf('TYPE=SUBTITLES') > 0 || t.indexOf('TYPE=CLOSED-CAPTIONS') > 0)) {
        var g = attr(t, 'GROUP-ID');
        if (g) subGroup = g;
        stats.nSub++; continue;
      }
      if (t.indexOf('#EXT-X-IMAGE-STREAM-INF') === 0) { stats.nImg++; continue; }
      var keep = line;
      if (subGroup && t.indexOf('#EXT-X-STREAM-INF') === 0) {
        var sg = attr(t, 'SUBTITLES');
        if (sg && sg === subGroup) { keep = keep.replace(/\s*SUBTITLES="[^"]*"/, '').replace(/,\s*,/, ','); stats.nSub++; }
      }
      if (t && t.charAt(0) !== '#' && looksAd(t)) { stats.nSeg++; continue; }
      out.push(keep);
    }
    // ⑤ 主目录规则(只在清单里有 DISC 或 KEY 时跑, 与 Java 一致)
    var joined = out.join('\n');
    if (joined.indexOf('DISCONTINUITY') >= 0 || joined.indexOf('#EXT-X-KEY') >= 0) {
      var killDir = byDominantDir(out, stats);
      if (killDir) out = out.filter(function (_l, idx) { return !killDir[idx]; });
    }
    // ⑥ 短插播块
    var killBlk = byShortBlocks(out, stats);
    if (killBlk) out = out.filter(function (_l, idx) { return !killBlk[idx]; });
    // ⑥b 钥匙(KEY)短块 —— 与 Java 的 byNoneKeyRuns 同一条规则:
    //   正片加密(AES-128)时, 把"连续、≤90 秒、占比≤25%"的 METHOD=NONE 分片段整块删掉。
    //   广告商把广告文件塞进正片目录时(异目录规则看不见), **加密方式**仍会不同 —— 靠这个抓。
    var killKey = byNoneKeyRuns(out, stats);
    if (killKey) out = out.filter(function (_l, idx) { return !killKey[idx]; });

    var add = stats.nSeg + stats.nCue + stats.nSub + stats.nImg + stats.nDir + stats.nBlk + stats.nKeyBlk;
    lastStats = stats;
    if (!add) return { text: text, dropped: 0, note: '' };
    dropped += add;
    note = '广告过滤: 去掉 ' + stats.nSeg + ' 段广告片 / ' + stats.nCue + ' 处 CUE 广告块 / '
      + stats.nSub + ' 处字幕注入 / ' + stats.nImg + ' 条预览图轨 / ' + stats.nDir + ' 段插入广告(异目录)'
      + (stats.nBlk ? (' / ' + stats.nBlk + ' 段短插播块') : '')
      + (stats.nKeyBlk ? (' / ' + stats.nKeyBlk + ' 段明流插播(钥匙不同)') : '');
    return { text: out.join('\n'), dropped: add, note: note };
  }

  var API = { filter: filter, looksAd: looksAd, reset: reset,
              stats: function () { return { dropped: dropped, note: note, last: lastStats }; } };
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
  root.AdFilterJS = API;
})(typeof self !== 'undefined' ? self : this);
