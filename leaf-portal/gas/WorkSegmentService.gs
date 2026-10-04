/**
 * WorkSegmentService.gs
 * ------------------------------------------------------------
 * 勤務区間（1日の中の勤務の区切り）です。
 *
 *   例：09:30〜16:00 出社 ＋ 18:00〜20:00 在宅 → 勤務区間 2つ。勤怠記録は 出勤 09:30／退勤 20:00／区間数 2
 *
 * 【記録の持ち方】
 *   勤務区間履歴 … 区間ごとに1行（勤務形態・開始時刻・終了時刻）。勤怠IDで勤怠記録とつなぐ
 *   勤怠記録     … これまでどおり1日1行の合計（出勤＝最初の開始、退勤＝最後の終了、勤務形態＝最初の区間）
 *   中断履歴     … これまでどおり。右端の「勤務区間ID」に、中断したときの区間を入れる
 *
 * 【計算（すべて時刻の重なりで計算するので、同じ中断を2回引くことはない）】
 *   区間の実働   = 区間の長さ − その区間と重なる中断
 *   出社・在宅・現場外出の時間 = 勤務形態ごとの区間の実働の合計
 *   自動休憩     = 1日に1回だけ（区間の実働の合計が「自動休憩_適用開始」を超えた日）。出社・在宅には振り分けない
 *   最終の実働   = 区間の実働の合計 − 自動休憩
 *   社内超過時間 = 標準退勤（18:30）より後に実際に働いた時間（その時間帯の中断は除く）。法定の時間外労働とは別
 *   遅刻 = 最初の区間の開始で判定、早退 = 最後の区間の終了で判定（固定勤務だけ。フレックスは判定しない）
 *
 * 【以前のデータ】
 *   勤務区間がない日は「出勤〜退勤」の1区間として読みます（シートには書きません）。
 *   勤務区間を書き込むのは、今の勤務（今日、または日付をまたいで続いている勤務）を操作したときだけです。
 *   過去の日を勤務区間に移すのは migrateAttendanceToWorkSegments() を明示して実行したときだけです。
 */

// ============================================================ 画面から呼ぶ関数

/**
 * 【画面から呼ぶ】勤務中に勤務形態を切り替える（出社・在宅・現場・外出）。
 * 今の区間をこの時刻で終え、新しい勤務形態の区間をこの時刻から始めます。
 * @param {string} workStyle 切り替え先
 * @param {object} [options] { site: '現場名' }
 */
function switchWorkStyle(workStyle, options) {
  return runApi_(function () {
    return withLock_(function () { return switchWorkStyle_(workStyle, options); });
  });
}

/**
 * 打刻のときに一緒に受け取る勤務区間の付帯情報（直行・直帰・現場名）を、シートに入れる形にする。
 * 時刻には影響しない。allowed で受け付ける項目を決める（例：直行は出勤・再出勤のときだけ）。
 */
function normalizeSegmentExtras_(options, allowed) {
  const o = options && typeof options === 'object' ? options : {};
  const out = {};
  if (allowed && allowed.direct && o.direct === true) out['直行'] = MARKS.YES;
  if (allowed && allowed.directReturn && o.directReturn === true) out['直帰'] = MARKS.YES;
  if (!(allowed && allowed.directReturn)) {
    const site = requireText_(o.site, '現場名', { required: false, max: TEXT_LIMITS.SHORT });
    if (site) out['現場名'] = site;
  }
  return out;
}

// ============================================================ シートの確認

/** 勤務区間履歴シートが使える状態か（setupSystem() 前なら false。そのときは以前と同じ動き） */
function hasWorkSegmentSchema_() {
  if (!getSpreadsheet_().getSheetByName(SHEET_NAMES.WORK_SEGMENTS)) return false;
  try {
    readTable_(SHEET_NAMES.WORK_SEGMENTS);
    return true;
  } catch (e) {
    return false;
  }
}

function requireWorkSegmentSchema_() {
  if (!hasWorkSegmentSchema_()) {
    fail_('勤務区間の準備ができていません。管理者が Apps Script で setupSystem() を実行してから、もう一度操作してください');
  }
}

/** シートにその列があるか（右端に追加する任意の列は、setupSystem() 前には無いことがある） */
function hasColumn_(sheetName, column) {
  return readTable_(sheetName).columnIndex[column] !== undefined;
}

/** 書き込む内容のうち、シートに列があるものだけを残す */
function onlyExistingColumns_(sheetName, changes) {
  const out = {};
  Object.keys(changes).forEach(function (k) { if (hasColumn_(sheetName, k)) out[k] = changes[k]; });
  return out;
}

// ============================================================ 勤務区間を読む

/** 勤怠IDごとの勤務区間（区間番号の順）。シートが無ければ空 */
function buildSegmentMap_() {
  const map = {};
  if (!hasWorkSegmentSchema_()) return map;
  readTable_(SHEET_NAMES.WORK_SEGMENTS).records.forEach(function (row) {
    const id = String(row['勤怠ID']).trim();
    if (!id) return;
    (map[id] = map[id] || []).push(row);
  });
  Object.keys(map).forEach(function (id) { map[id].sort(compareSegmentRows_); });
  return map;
}

function compareSegmentRows_(a, b) {
  const na = Number(a['区間番号']) || 0;
  const nb = Number(b['区間番号']) || 0;
  if (na !== nb) return na - nb;
  return (toMinutes_(a['開始時刻']) || 0) - (toMinutes_(b['開始時刻']) || 0);
}

/** 勤怠記録1件の勤務区間の行（シートにある分だけ） */
function getSegmentRowsOfAttendance_(attendanceId) {
  if (!hasWorkSegmentSchema_()) return [];
  const id = String(attendanceId).trim();
  return findRecords_(SHEET_NAMES.WORK_SEGMENTS, function (r) { return String(r['勤怠ID']).trim() === id; })
    .sort(compareSegmentRows_);
}

/**
 * 勤怠記録1件の勤務区間を、計算に使う形で返す。
 * シートに区間がない日（以前の記録）は「出勤〜退勤」の1区間として読む（シートには書かない）。
 * 戻り値：[{ id, number, style, startMinutes, endMinutes(null=勤務中), row(シートの行 or null), virtual }]
 */
function getDaySegments_(record, segmentRows) {
  const rows = segmentRows || [];
  if (rows.length) {
    return rows.map(function (row) {
      return {
        id: toPlainText_(row['勤務区間ID']),
        number: Number(row['区間番号']) || 0,
        style: toPlainText_(row['勤務形態']) || WORK_STYLES.OFFICE,
        startMinutes: toMinutes_(row['開始時刻']),
        endMinutes: toMinutes_(row['終了時刻']),
        direct: !isBlank_(row['直行']),
        directReturn: !isBlank_(row['直帰']),
        site: toPlainText_(row['現場名']),
        note: toPlainText_(row['備考']),
        startStamp: toPlainText_(row['開始打刻日時']),
        endStamp: toPlainText_(row['終了打刻日時']),
        row: row,
        virtual: false,
      };
    }).filter(function (s) { return s.startMinutes !== null; });
  }
  const clockIn = toMinutes_(record['出勤']);
  if (clockIn === null) return [];
  return [{
    id: '',
    number: 1,
    style: toPlainText_(record['勤務形態']) || WORK_STYLES.OFFICE,
    startMinutes: clockIn,
    endMinutes: toMinutes_(record['退勤']),
    row: null,
    virtual: true,
  }];
}

/** 今の区間（終了時刻がない区間）。なければ null */
function findOpenSegment_(segments) {
  const open = segments.filter(function (s) { return s.endMinutes === null; });
  return open.length ? open[open.length - 1] : null;
}

/**
 * 1日のまとめ（出勤・退勤・最初の勤務形態）を、すべての勤務区間から毎回作り直す。
 *   出勤 = 全区間の最小の開始、退勤 = 終了済みの区間の最大の終了（勤務中の区間があるときは空欄）
 *   勤務形態 = 最初に始まった区間の勤務形態
 * 再出勤・切替・中断のあとでも、出勤（最初の開始）は変わらない。
 */
function summarizeDaySegments_(segments) {
  if (!segments.length) return null;
  const timeline = toDayTimeline_(segments, []);
  let first = 0;
  timeline.segments.forEach(function (s, i) { if (s.start < timeline.segments[first].start) first = i; });
  let lastEnd = null;
  let lastIndex = segments.length - 1;
  timeline.segments.forEach(function (s, i) { if (s.end !== null && (lastEnd === null || s.end > lastEnd)) { lastEnd = s.end; lastIndex = i; } });
  const open = findOpenSegment_(segments);
  if (open) lastIndex = segments.indexOf(open);
  return {
    firstIndex: first,
    lastIndex: lastIndex, // 退勤を直すときの区間（勤務中の区間があればその区間、なければ最後に終わった区間）
    clockInMinutes: segments[first].startMinutes,
    clockOutMinutes: open || lastEnd === null ? null : lastEnd % 1440,
    clockIn: minutesToClock_(segments[first].startMinutes),
    clockOut: open || lastEnd === null ? '' : minutesToClock_(lastEnd),
    workStyle: segments[first].style,
    hasOpen: !!open,
    // 日の属性「直行」「直帰」：最初に始まった区間が直行、最後に終わった区間が直帰なら ○（正は勤務区間）
    direct: !!segments[first].direct,
    directReturn: !open && lastEnd !== null && !!segments[lastIndex].directReturn,
  };
}

// ============================================================ 計算（シートを使わない純粋な計算）

/**
 * 区間と中断の時刻を、その日の最初の開始を基準にした「通しの分」に直す。
 * 最初の開始より前の時刻は翌日とみなして 1440 を足す（日付をまたぐ勤務・再出勤に対応）。
 */
function toDayTimeline_(segments, interruptions) {
  if (!segments.length) return { segments: [], interruptions: [] };
  const dayStart = segments[0].startMinutes;
  const abs = function (m) { return m < dayStart ? m + 1440 : m; };
  const segs = segments.map(function (s) {
    const start = abs(s.startMinutes);
    return {
      style: s.style,
      start: start,
      end: s.endMinutes === null || s.endMinutes === undefined ? null : start + durationBetween_(s.startMinutes, s.endMinutes),
    };
  });
  const ints = (interruptions || [])
    .filter(function (b) { return b.startMinutes !== null && b.endMinutes !== null && b.startMinutes !== undefined && b.endMinutes !== undefined; })
    .map(function (b) {
      const start = abs(b.startMinutes);
      return { start: start, end: start + durationBetween_(b.startMinutes, b.endMinutes) };
    });
  return { segments: segs, interruptions: mergeIntervals_(ints) };
}

/** 重なっている時間帯をまとめる（同じ時間を2回数えないため） */
function mergeIntervals_(intervals) {
  const sorted = intervals.filter(function (x) { return x.end > x.start; })
    .map(function (x) { return { start: x.start, end: x.end }; })
    .sort(function (a, b) { return a.start - b.start; });
  const merged = [];
  sorted.forEach(function (x) {
    const last = merged[merged.length - 1];
    if (last && x.start <= last.end) last.end = Math.max(last.end, x.end);
    else merged.push(x);
  });
  return merged;
}

/** 2つの時間帯の重なり（分） */
function overlapMinutes_(aStart, aEnd, bStart, bEnd) {
  return Math.max(0, Math.min(aEnd, bEnd) - Math.max(aStart, bStart));
}

/** 時間帯 [start, end) と、まとめた中断との重なりの合計（分） */
function overlapWithIntervals_(start, end, intervals) {
  return intervals.reduce(function (sum, x) { return sum + overlapMinutes_(start, end, x.start, x.end); }, 0);
}

/**
 * 勤務区間から1日の勤務時間を計算する（すべて終わった区間で計算する）。
 * @param {object} p
 *   segments       [{ style, startMinutes, endMinutes }]（区間番号の順。0時からの分）
 *   interruptions  [{ startMinutes, endMinutes }]（再開済みの中断）
 *   isFixed, standardStartMinutes, standardEndMinutes, autoBreakMinutes, autoBreakThresholdMinutes,
 *   overtimeFreeLimitMinutes, overtimeUnitMinutes … calculateWorkTime_ と同じ
 */
function calculateSegmentedWorkTime_(p) {
  const timeline = toDayTimeline_(p.segments, p.interruptions);
  const styleMinutes = {};
  segmentWorkStyles_().forEach(function (s) { styleMinutes[s] = 0; });

  let gross = 0;
  let deducted = 0;
  let excessRaw = 0;
  const segmentResults = timeline.segments.map(function (s) {
    const length = Math.max(0, s.end - s.start);
    const cut = overlapWithIntervals_(s.start, s.end, timeline.interruptions);
    const net = Math.max(0, length - cut);
    gross += length;
    deducted += cut;
    styleMinutes[s.style] = (styleMinutes[s.style] || 0) + net;
    // 標準退勤より後に、中断を除いて実際に働いた時間
    const afterStart = Math.max(s.start, p.standardEndMinutes);
    if (s.end > afterStart) {
      excessRaw += (s.end - afterStart) - overlapWithIntervals_(afterStart, s.end, timeline.interruptions);
    }
    return { style: s.style, startAbs: s.start, endAbs: s.end, lengthMinutes: length, interruptionMinutes: cut, netMinutes: net };
  });

  const workBeforeBreak = gross - deducted;
  const autoBreakMinutes = workBeforeBreak > p.autoBreakThresholdMinutes ? p.autoBreakMinutes : 0;
  // 遅刻は全区間の最小の開始、早退は最大の終了で判定する（区間番号の順ではなく時刻で）
  const firstStart = timeline.segments.reduce(function (m, s) { return Math.min(m, s.start); }, timeline.segments.length ? timeline.segments[0].start : 0);
  const lastEnd = timeline.segments.reduce(function (m, s) { return Math.max(m, s.end); }, firstStart);

  const result = {
    segmentCount: timeline.segments.length,
    segments: segmentResults,
    grossMinutes: gross,
    interruptionMinutes: deducted,
    workBeforeAutoBreakMinutes: workBeforeBreak,
    autoBreakMinutes: autoBreakMinutes,
    netMinutes: Math.max(0, workBeforeBreak - autoBreakMinutes),
    styleMinutes: styleMinutes,
    officeMinutes: styleMinutes[WORK_STYLES.OFFICE] || 0,
    remoteMinutes: styleMinutes[WORK_STYLES.REMOTE] || 0,
    siteOutingMinutes: (styleMinutes[WORK_STYLES.SITE] || 0) + (styleMinutes[WORK_STYLES.OUTING] || 0),
    firstStartMinutes: firstStart,
    lastEndMinutes: lastEnd,
    lateMinutes: 0,
    earlyLeaveMinutes: 0,
    internalExcessMinutes: 0,
    requiresPreApproval: false,
  };
  if (!p.isFixed) return result;

  result.lateMinutes = Math.max(0, firstStart - p.standardStartMinutes);
  result.earlyLeaveMinutes = Math.max(0, p.standardEndMinutes - lastEnd);
  result.internalExcessMinutes = Math.floor(Math.max(0, excessRaw) / p.overtimeUnitMinutes) * p.overtimeUnitMinutes;
  result.requiresPreApproval = result.internalExcessMinutes > 0 && result.internalExcessMinutes >= p.overtimeFreeLimitMinutes;
  return result;
}

/** 「出社＋在宅」のような勤務形態区分（決まった順番で並べる） */
function workStyleCategory_(segments) {
  const used = {};
  segments.forEach(function (s) { used[s.style] = true; });
  const order = segmentWorkStyles_();
  const known = order.filter(function (s) { return used[s]; });
  const others = Object.keys(used).filter(function (s) { return order.indexOf(s) === -1; });
  return known.concat(others).join('＋');
}

// ============================================================ 勤務区間を書く

function makeSegmentId_(attendanceId, number) {
  return makeUniqueId_(SHEET_NAMES.WORK_SEGMENTS, '勤務区間ID', 'WS-' + String(attendanceId).replace(/^AT-/, '') + '-' + pad2_(number));
}

/**
 * 区間を1つ追加する（すでにある区間の開始時刻・勤務形態は書き換えない）。
 * @param {string} [startStamp] 実際に打刻した日時（秒まで）。以前の記録から作るときは空
 */
function appendSegment_(record, style, startText, endText, timestamp, startStamp, extras) {
  const attendanceId = String(record['勤怠ID']).trim();
  const number = getSegmentRowsOfAttendance_(attendanceId).reduce(function (m, r) { return Math.max(m, Number(r['区間番号']) || 0); }, 0) + 1;
  return appendRecord_(SHEET_NAMES.WORK_SEGMENTS, onlyExistingColumns_(SHEET_NAMES.WORK_SEGMENTS, {
    '勤務区間ID': makeSegmentId_(attendanceId, number),
    '勤怠ID': attendanceId,
    '日付': toDateKey_(record['日付']),
    '社員ID': toPlainText_(record['社員ID']),
    '氏名': toPlainText_(record['氏名']),
    '区間番号': String(number),
    '勤務形態': style,
    '開始時刻': startText,
    '終了時刻': endText || '',
    '作成日時': timestamp,
    '更新日時': timestamp,
    '開始打刻日時': startStamp || '',
    '直行': (extras && extras['直行']) || '',
    '現場名': (extras && extras['現場名']) || '',
  }));
}

/**
 * 今の勤務（今日の記録）に勤務区間がなければ、出勤〜退勤から1区間を作る。
 * 以前のコードで出勤した今日の記録を、切替や再出勤できるようにするため（過去の日には使わない）。
 * その日の中断のうち勤務区間IDが空のものには、作った区間のIDを入れる。
 * 戻り値：シートの勤務区間の行（区間番号の順）
 */
function ensureSegmentsForCurrent_(record, timestamp) {
  const attendanceId = String(record['勤怠ID']).trim();
  const rows = getSegmentRowsOfAttendance_(attendanceId);
  if (rows.length || isBlank_(record['出勤'])) return rows;
  const created = appendSegment_(record, toPlainText_(record['勤務形態']) || WORK_STYLES.OFFICE,
    toClockText_(record['出勤']), toClockText_(record['退勤']), timestamp);
  assignSegmentToBreaks_(attendanceId, String(created['勤務区間ID']));
  return [created];
}

/** 勤務区間IDが空の中断に、区間IDを入れる（列が無ければ何もしない） */
function assignSegmentToBreaks_(attendanceId, segmentId) {
  if (!hasColumn_(SHEET_NAMES.BREAKS, '勤務区間ID')) return 0;
  let count = 0;
  getBreaksOfAttendance_(attendanceId).forEach(function (b) {
    if (isBlank_(b['勤務区間ID'])) {
      updateRecord_(SHEET_NAMES.BREAKS, b, { '勤務区間ID': segmentId });
      count += 1;
    }
  });
  return count;
}

/** 区間の終了時刻を入れる（endStamp＝実際の打刻日時。秒まで） */
function closeSegmentRow_(row, endText, timestamp, endStamp) {
  updateRecord_(SHEET_NAMES.WORK_SEGMENTS, row, onlyExistingColumns_(SHEET_NAMES.WORK_SEGMENTS, {
    '終了時刻': endText, '更新日時': timestamp, '終了打刻日時': endStamp || '',
  }));
}

/** 今の区間（終了時刻が空の行） */
function findOpenSegmentRow_(rows) {
  const open = rows.filter(function (r) { return isBlank_(r['終了時刻']); });
  return open.length ? open[open.length - 1] : null;
}

/**
 * 今の区間を endText で終え、新しい勤務形態の区間を startText から始める。
 * 同じ分の中の操作で今の区間が0分になっても、今の区間の開始・勤務形態は書き換えない（出勤＝最初の開始を守る）。
 * @param {string} endStamp / startStamp 実際の打刻日時（秒まで）
 */
function closeAndStartSegment_(record, openRow, endText, style, startText, timestamp, endStamp, startStamp, extras) {
  closeSegmentRow_(openRow, endText, timestamp, endStamp);
  return appendSegment_(record, style, startText, '', timestamp, startStamp, extras);
}

// ============================================================ 切替

function switchWorkStyle_(workStyle, options) {
  const style = requireChoice_(workStyle, punchWorkStyles_(), '切り替え先の勤務形態');
  const extras = normalizeSegmentExtras_(options, {});
  const staff = getCurrentStaff_();
  requireActiveStaff_(staff);
  requireWorkSegmentSchema_();
  const now = getNowInfo_();
  const record = findCurrentAttendance_(staff.employeeId, now.date);

  if (!record) fail_('本日はまだ出勤していません。先に「出勤」を押してください');
  const status = String(record['状態']);
  if (status === ATTENDANCE_STATUS.ON_BREAK) fail_('中断中は切り替えできません。「出社で再開」または「在宅で再開」を押してください');
  if (status === ATTENDANCE_STATUS.FINISHED) fail_('本日はすでに退勤済みです。「出社で再出勤」または「在宅で再出勤」を押してください');
  if (status !== ATTENDANCE_STATUS.WORKING) fail_('勤務中ではないため切り替えできません（今の状態：' + status + '）');

  const rows = ensureSegmentsForCurrent_(record, now.timestamp);
  const open = findOpenSegmentRow_(rows);
  if (!open) fail_('今の勤務区間が見つかりません。管理者に連絡してください');
  if (toPlainText_(open['勤務形態']) === style) fail_('すでに' + style + 'で勤務中です');

  const from = toPlainText_(open['勤務形態']);
  closeAndStartSegment_(record, open, now.time, style, now.time, now.timestamp, now.timestamp, now.timestamp, extras);
  recalculateAttendanceRecord_(record, now.timestamp, { segmentsWin: true });
  return { message: from + 'から' + style + 'に切り替えました（' + now.time + '）', data: toAttendanceView_(record) };
}

// ============================================================ 画面へ返す形

/**
 * 勤怠記録1件のタイムライン（勤務区間と中断）。本人または管理者にだけ返すこと。
 * 戻り値：{ events: [{ time, kind, label }]（操作の順。下の buildTimelineEvents_）,
 *          segments: [{ number, style, start, end, workTime, virtual }], breaks: [{ start, end, minutes, reason }],
 *          currentStyle, segmentCount, showSeconds }
 * showSeconds が true（テスト環境）のときだけ、events の time を秒まで（HH:mm:ss）にする。
 */
function buildAttendanceTimeline_(record, options) {
  const attendanceId = String(record['勤怠ID']).trim();
  const segments = getDaySegments_(record, getSegmentRowsOfAttendance_(attendanceId));
  const breaks = getBreaksOfAttendance_(attendanceId);
  const open = findOpenSegment_(segments);
  const showSeconds = options && options.showSeconds !== undefined ? !!options.showSeconds : getEnvironmentLabel_() !== '';
  const stampTime = function (stamp, clock) {
    const m = String(stamp || '').match(/\d{2}:\d{2}:\d{2}$/);
    return showSeconds && m && m[0].slice(0, 5) === clock ? m[0] : clock;
  };
  return {
    events: buildTimelineEvents_(segments, breaks.map(function (b) {
      return {
        segmentId: toPlainText_(b['勤務区間ID']),
        startMinutes: toMinutes_(b['中断開始']),
        endMinutes: toMinutes_(b['再開']),
        startStamp: toPlainText_(b['中断打刻日時']),
        endStamp: toPlainText_(b['再開打刻日時']),
      };
    })).map(function (e) {
      return { time: stampTime(e.stamp, minutesToClock_(e.minutes)), kind: e.kind, label: e.label, style: e.style || '' };
    }),
    segments: segments.map(function (s) {
      return {
        number: s.number,
        style: s.style,
        start: stampTime(s.startStamp, minutesToClock_(s.startMinutes)),
        end: s.endMinutes === null ? '' : stampTime(s.endStamp, minutesToClock_(s.endMinutes)),
        workTime: s.row ? toDurationText_(s.row['区間実働']) : '',
        virtual: s.virtual,
      };
    }),
    breaks: breaks.map(function (b) {
      return {
        start: stampTime(b['中断打刻日時'], toClockText_(b['中断開始'])),
        end: stampTime(b['再開打刻日時'], toClockText_(b['再開'])),
        minutes: toDurationText_(b['中断時間']),
        reason: toPlainText_(b['理由']),
      };
    }),
    currentStyle: open ? open.style : '',
    segmentCount: segments.length,
    showSeconds: showSeconds,
  };
}

/**
 * 勤務区間と中断を、操作の内容が分かる時系列の出来事にする（シートを使わない純粋な計算）。
 *   例：12:05 出社で出勤／12:07 中断／12:08 再開（出社）／12:09 在宅へ切替／12:10 中断／12:11 再開（在宅）／12:12 退勤／12:15 在宅で再出勤
 * 並び順：時刻（その日の最初の開始を基準に、12時間以上前の時刻は翌日とみなす）→ 同じ分の中は操作の順番
 *        （区間ごとに「開始 → その区間の中断・再開（記録の順）→ 終了」）。
 * @param {object[]} segments getDaySegments_ の戻り値（区間番号の順）
 * @param {object[]} breaks   [{ segmentId, startMinutes, endMinutes, startStamp, endStamp }]（中断履歴の順）
 * 戻り値：[{ minutes, abs, kind, label, style, stamp }]
 */
function buildTimelineEvents_(segments, breaks) {
  if (!segments.length) return [];
  // 基準は区間1（その日に最初に作った区間）の開始。日付をまたいだ時刻（基準より12時間以上前）は翌日として後ろに並べる
  const dayStart = segments[0].startMinutes;
  const abs = function (m) { return m < dayStart - 720 ? m + 1440 : m; };
  const segAbs = segments.map(function (s) {
    const start = abs(s.startMinutes);
    return { start: start, end: s.endMinutes === null ? null : start + durationBetween_(s.startMinutes, s.endMinutes) };
  });
  // 中断がどの区間のものか（勤務区間IDがあればそれ、なければ中断開始を含む区間）
  const ownerOf = function (b, bStart) {
    if (b.segmentId) {
      for (let i = 0; i < segments.length; i++) if (segments[i].id === b.segmentId) return i;
    }
    let owner = 0;
    segAbs.forEach(function (s, i) { if (s.start <= bStart) owner = i; });
    return owner;
  };
  const events = [];
  const add = function (minutes, rank, kind, label, style, stamp) {
    events.push({ minutes: ((minutes % 1440) + 1440) % 1440, abs: minutes, rank: rank, kind: kind, label: label, style: style, stamp: stamp || '' });
  };
  const brs = breaks.filter(function (b) { return b.startMinutes !== null && b.startMinutes !== undefined; }).map(function (b, i) {
    const start = abs(b.startMinutes);
    const end = b.endMinutes === null || b.endMinutes === undefined ? null : start + durationBetween_(b.startMinutes, b.endMinutes);
    return { b: b, i: i, start: start, end: end, owner: ownerOf(b, start), consumed: false };
  });

  // 先に「中断 → 別の勤務形態で再開」を見つけておく（前の区間の終わりに中断し、その再開で次の区間が始まった）
  const resumedBy = {};
  segments.forEach(function (s, k) {
    if (k === 0) return;
    const prev = segAbs[k - 1];
    const cur = segAbs[k];
    const hit = brs.filter(function (x) { return !x.consumed && x.owner === k - 1 && prev.end !== null && x.start === prev.end && x.end === cur.start; })[0];
    if (hit) { hit.consumed = true; resumedBy[k] = hit; }
  });

  segments.forEach(function (s, k) {
    const cur = segAbs[k];
    const base = k * 10000;
    const extra = (s.direct ? '・直行' : '') + (s.site ? '（' + s.site + '）' : '');
    if (k === 0) {
      add(cur.start, base, 'start', s.style + 'で出勤' + extra, s.style, s.startStamp);
    } else {
      const prev = segAbs[k - 1];
      const resumed = resumedBy[k];
      if (resumed) {
        add(cur.start, base, 'resume', '再開（' + s.style + '）' + extra, s.style, s.startStamp || resumed.b.endStamp);
      } else if (prev.end !== null && prev.end === cur.start && isSwitchBoundary_(segments, k - 1)) {
        add(cur.start, base, 'switch', s.style + 'へ切替' + extra, s.style, s.startStamp);
      } else {
        add(cur.start, base, 'reclockin', s.style + 'で再出勤' + extra, s.style, s.startStamp);
      }
    }
    brs.filter(function (x) { return x.owner === k; }).forEach(function (x) {
      add(x.start, base + 1 + x.i * 2, 'break', '中断', '', x.b.startStamp);
      if (x.end !== null && !x.consumed) {
        const owner = segments[k];
        add(x.end, base + 2 + x.i * 2, 'resume', '再開（' + owner.style + '）', owner.style, x.b.endStamp);
      }
    });
    if (cur.end !== null) {
      const next = segAbs[k + 1];
      const switched = next && next.start === cur.end && isSwitchBoundary_(segments, k);
      const intoBreak = next && brs.some(function (x) { return x.owner === k && x.start === cur.end && x.end === next.start; });
      // 次の区間がこの終わりから続く（切替・中断からの再開）なら「退勤」は出さない
      if (!switched && !intoBreak) {
        add(cur.end, base + 9999, 'end', s.directReturn ? '退勤（直帰）' : '退勤', s.style, s.endStamp);
      }
    }
  });
  events.sort(function (a, b) { return a.abs !== b.abs ? a.abs - b.abs : a.rank - b.rank; });
  return events;
}

/**
 * 区間 k の終わりと区間 k+1 の始まりが同じ時刻のとき、それが「切替」か（退勤→同じ分に再出勤ではないか）。
 * 勤務形態が同じなら必ず退勤→再出勤（同じ勤務形態への切替はできない）。
 * 打刻日時（秒）が両方あれば、切替は同じ打刻（同じ日時）、退勤→再出勤は別の打刻になる。
 * 打刻日時がない（以前の記録・打刻修正後）ときは、勤務形態が変わっていれば切替とみなす。
 */
function isSwitchBoundary_(segments, k) {
  const cur = segments[k];
  const next = segments[k + 1];
  if (cur.style === next.style) return false; // 同じ勤務形態への切替はできないので、退勤→再出勤
  if (cur.endStamp && next.startStamp) return cur.endStamp === next.startStamp;
  return cur.style !== next.style;
}

/** 今の勤務形態（勤務中・中断中なら今の区間、それ以外は勤怠記録の勤務形態） */
function getCurrentWorkStyle_(record) {
  const status = String(record['状態']);
  if (status === ATTENDANCE_STATUS.WORKING || status === ATTENDANCE_STATUS.ON_BREAK) {
    const open = findOpenSegment_(getDaySegments_(record, getSegmentRowsOfAttendance_(String(record['勤怠ID']).trim())));
    if (open) return open.style;
  }
  return toPlainText_(record['勤務形態']);
}

// ============================================================ 以前の勤怠を勤務区間へ移す（明示して実行したときだけ）

/**
 * 【Apps Script のエディタから実行】勤務区間がない勤怠記録に、出勤〜退勤の1区間を作る。
 * 初期設定は「確認だけ（dry-run）」で、シートには何も書きません。実行ログに件数と予定の内容を出します。
 *   migrateAttendanceToWorkSegments()                    … 確認だけ
 *   migrateAttendanceToWorkSegments({ execute: true })   … 書き込む
 *   { from: '2026-08-21', to: '2026-09-20' } を足すと期間を絞れます
 * すでに勤務区間がある日は飛ばすので、2回目以降に実行しても何も変わりません。
 * 勤怠記録の値（出勤・退勤・実働など）は変えません。setupSystem() からは呼びません。
 * 実行する前に、スプレッドシートのコピーを作ってください（README「S」）。
 */
function migrateAttendanceToWorkSegments(options) {
  requireEditorExecution_('migrateAttendanceToWorkSegments');
  const opts = options || {};
  const execute = opts.execute === true;
  const result = withLock_(function () {
    requireWorkSegmentSchema_();
    const from = isBlank_(opts.from) ? '' : requireDateKey_(opts.from, '開始日');
    const to = isBlank_(opts.to) ? '' : requireDateKey_(opts.to, '終了日');
    const segmentMap = buildSegmentMap_();
    const hasBreakColumn = hasColumn_(SHEET_NAMES.BREAKS, '勤務区間ID');
    const breaksByAttendance = {};
    readTable_(SHEET_NAMES.BREAKS).records.forEach(function (b) {
      const id = String(b['勤怠ID']).trim();
      (breaksByAttendance[id] = breaksByAttendance[id] || []).push(b);
    });

    const plans = [];
    let skippedExisting = 0;
    let skippedNoClockIn = 0;
    readTable_(SHEET_NAMES.ATTENDANCE).records.forEach(function (r) {
      const date = toDateKey_(r['日付']);
      if ((from && date < from) || (to && date > to)) return;
      const id = String(r['勤怠ID']).trim();
      if (!id) return;
      if (segmentMap[id] && segmentMap[id].length) { skippedExisting += 1; return; }
      if (isBlank_(r['出勤'])) { skippedNoClockIn += 1; return; }
      const breaks = hasBreakColumn ? (breaksByAttendance[id] || []).filter(function (b) { return isBlank_(b['勤務区間ID']); }) : [];
      plans.push({ record: r, breaks: breaks });
    });

    const now = getNowInfo_();
    const lines = plans.slice(0, 50).map(function (p) {
      return toDateKey_(p.record['日付']) + ' ' + toPlainText_(p.record['氏名']) + '：' +
        (toPlainText_(p.record['勤務形態']) || WORK_STYLES.OFFICE) + ' ' + toClockText_(p.record['出勤']) + '〜' +
        (toClockText_(p.record['退勤']) || '（勤務中）') + (p.breaks.length ? '（中断 ' + p.breaks.length + '件に区間IDを入れる）' : '');
    });
    const breakCount = plans.reduce(function (s, p) { return s + p.breaks.length; }, 0);

    if (execute && plans.length) {
      const used = {};
      readTable_(SHEET_NAMES.WORK_SEGMENTS).records.forEach(function (row) { used[String(row['勤務区間ID'])] = true; });
      const objects = plans.map(function (p) {
        const attendanceId = String(p.record['勤怠ID']).trim();
        let segmentId = 'WS-' + attendanceId.replace(/^AT-/, '') + '-01';
        for (let n = 2; used[segmentId]; n++) segmentId = 'WS-' + attendanceId.replace(/^AT-/, '') + '-01-' + n;
        used[segmentId] = true;
        p.segmentId = segmentId;
        return {
          '勤務区間ID': segmentId,
          '勤怠ID': attendanceId,
          '日付': toDateKey_(p.record['日付']),
          '社員ID': toPlainText_(p.record['社員ID']),
          '氏名': toPlainText_(p.record['氏名']),
          '区間番号': '1',
          '勤務形態': toPlainText_(p.record['勤務形態']) || WORK_STYLES.OFFICE,
          '開始時刻': toClockText_(p.record['出勤']),
          '終了時刻': toClockText_(p.record['退勤']),
          '備考': '以前の勤怠記録から作成',
          '作成日時': now.timestamp,
          '更新日時': now.timestamp,
        };
      });
      appendRecords_(SHEET_NAMES.WORK_SEGMENTS, objects);
      plans.forEach(function (p) {
        p.breaks.forEach(function (b) { updateRecord_(SHEET_NAMES.BREAKS, b, { '勤務区間ID': p.segmentId }); });
      });
    }

    const head = (execute ? '【勤務区間への移行（実行）】' : '【勤務区間への移行（確認だけ・dry-run）】') +
      (from || to ? '期間 ' + (from || '最初') + '〜' + (to || '最後') + '／' : '') +
      '対象 ' + plans.length + '件（作る区間 ' + plans.length + '件・区間IDを入れる中断 ' + breakCount + '件）' +
      '／すでに区間あり ' + skippedExisting + '件／出勤なし ' + skippedNoClockIn + '件';
    const tail = execute
      ? (plans.length ? '書き込みました。勤怠記録の値（出勤・退勤・実働など）は変えていません' : '書き込む対象はありませんでした')
      : 'シートには何も書いていません。書き込むときは migrateAttendanceToWorkSegments({ execute: true }) を実行してください';
    const message = head + (lines.length ? '\n' + lines.join('\n') + (plans.length > lines.length ? '\n…ほか ' + (plans.length - lines.length) + '件' : '') : '') + '\n' + tail;
    return {
      message: message,
      data: { execute: execute, targetCount: plans.length, segmentCount: execute ? plans.length : 0, plannedSegments: plans.length,
        breakCount: breakCount, skippedExisting: skippedExisting, skippedNoClockIn: skippedNoClockIn },
    };
  });
  console.log(result.message);
  return result;
}
