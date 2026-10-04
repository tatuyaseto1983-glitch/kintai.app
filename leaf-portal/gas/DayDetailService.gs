/**
 * DayDetailService.gs
 * ------------------------------------------------------------
 * 1日の「付帯情報」です。実働時間には影響しないので、本人が今の20日締め期間の分を承認なしで直せます。
 *
 *   区間ごと：直行・直帰・現場名・備考（勤務区間履歴の列）
 *   日ごと  ：日備考・出張（勤怠記録の右端の列）
 *   自家用車：「自家用車を業務で使用 ＋ ○km」＝交通費明細の自家用車の行（距離は交通費明細だけに保存）
 *
 * 時刻（開始・終了）と勤務形態は、ここでは変えられません。これまでどおり打刻修正申請（管理者の承認）を通します。
 * 日備考・出張・区間の直行／直帰などは、勤怠記録がある日だけ編集できます（交通費は勤怠記録がない日も登録できます）。
 */

/**
 * 【画面から呼ぶ】自分の1日の付帯情報。
 * @param {string} date '2026-10-05'
 */
function getMyDayDetail(date) {
  return runApi_(function () {
    const staff = getCurrentStaff_();
    const now = getNowInfo_();
    const dateKey = requireDateKey_(date, '日付');
    return { message: dateKey + ' の詳細を取得しました', data: buildMyDayDetail_(staff, dateKey, now) };
  });
}

/**
 * 【画面から呼ぶ】自分の1日の付帯情報を保存する（今の締め期間の、今日までの日だけ）。
 * @param {object} input
 *   date
 *   dayNote, businessTrip(true/false)                 … 勤怠記録がある日だけ
 *   segments: [{ number, direct, directReturn, site, note }] … 勤務区間がある日だけ（時刻・勤務形態は変えない）
 *   car: { use: true/false, km: '32.5' }               … 交通費明細の自家用車の行（勤怠記録がない日も可）
 *   省略した項目は変えない。
 */
function saveMyDayDetail(input) {
  return runApi_(function () {
    return withLock_(function () {
      const staff = getCurrentStaff_();
      const now = getNowInfo_();
      const p = input || {};
      const dateKey = requireDateKey_(p.date, '日付');
      requireDetailEditable_(dateKey, now);
      const record = findAttendance_(staff.employeeId, dateKey);
      const changed = [];

      // 日ごと（勤怠記録がある日だけ）
      if (p.dayNote !== undefined || p.businessTrip !== undefined) {
        if (!record) fail_(dateKey + ' は勤怠記録がないため、日備考・出張は入力できません（交通費は登録できます）');
        const fields = {};
        if (p.dayNote !== undefined) fields['日備考'] = requireText_(p.dayNote, '日備考', { required: false, max: TEXT_LIMITS.LONG });
        if (p.businessTrip !== undefined) fields['出張'] = p.businessTrip === true ? MARKS.YES : '';
        const writable = onlyExistingColumns_(SHEET_NAMES.ATTENDANCE, fields);
        if (Object.keys(writable).length !== Object.keys(fields).length) {
          fail_('日備考・出張の準備ができていません。管理者が setupSystem() を実行してから入力してください');
        }
        if (Object.keys(writable).some(function (k) { return toPlainText_(record[k]) !== writable[k]; })) {
          writable['更新日時'] = now.timestamp;
          updateRecord_(SHEET_NAMES.ATTENDANCE, record, writable);
          changed.push('日の情報');
        }
      }

      // 区間ごと（勤務区間がある日だけ。時刻・勤務形態は変えない）
      if (Array.isArray(p.segments) && p.segments.length) {
        if (!record) fail_(dateKey + ' は勤怠記録がないため、区間の直行・直帰・現場名は入力できません');
        const rows = getSegmentRowsOfAttendance_(String(record['勤怠ID']).trim());
        if (!rows.length) fail_(dateKey + ' は以前の記録のため、区間ごとの入力はできません。日備考に書いてください');
        let segChanged = false;
        const daySegs = getDaySegments_(record, rows);
        const firstNumber = daySegs[summarizeDaySegments_(daySegs).firstIndex].number;
        p.segments.forEach(function (sg) {
          const no = Number(sg && sg.number);
          const row = rows.filter(function (r) { return Number(r['区間番号']) === no; })[0];
          if (!row) fail_('区間' + (sg && sg.number) + ' はありません（' + dateKey + ' の区間は ' + rows.length + 'つです）');
          // 直行は最初の区間だけ直せる。2つ目以降の区間の直行は変えない（以前の版のデータもそのまま残す）
          const isFirst = Number(row['区間番号']) === firstNumber;
          if (!isFirst && sg.direct === true && isBlank_(row['直行'])) fail_('直行は、その日の最初の区間（最初の出勤）だけに付けられます');
          const fields = {
            '直行': isFirst ? (sg.direct === true ? MARKS.YES : '') : toPlainText_(row['直行']),
            '直帰': sg.directReturn === true ? MARKS.YES : '',
            '現場名': requireText_(sg.site, '現場名', { required: false, max: TEXT_LIMITS.SHORT }),
            '備考': requireText_(sg.note, '区間の備考', { required: false, max: TEXT_LIMITS.LONG }),
          };
          if (Object.keys(fields).some(function (k) { return toPlainText_(row[k]) !== fields[k]; })) {
            fields['更新日時'] = now.timestamp;
            updateRecord_(SHEET_NAMES.WORK_SEGMENTS, row, fields);
            segChanged = true;
          }
        });
        if (segChanged) {
          refreshDirectSummary_(record, now.timestamp);
          changed.push('区間の情報');
        }
      }

      // 自家用車（交通費明細の自家用車の行。距離の正はここだけ）
      if (p.car && typeof p.car === 'object') {
        const result = saveCarUsage_(staff, dateKey, p.car, record, now);
        if (result) changed.push(result);
      }

      return {
        message: changed.length ? dateKey + ' の' + changed.join('・') + 'を保存しました' : '変更はありませんでした',
        data: buildMyDayDetail_(staff, dateKey, now),
      };
    });
  });
}

/** 付帯情報を本人が直せる日か（今の締め期間の、今日までの日） */
function requireDetailEditable_(dateKey, now) {
  const current = getPayrollPeriodForDate_(now.date);
  if (dateKey > now.date) fail_('未来の日付は入力できません');
  if (dateKey < current.from) fail_(dateKey + ' は締めた後の期間（' + getPayrollPeriodForDate_(dateKey).label + '）のため変更できません。修正が必要なときは管理者に連絡してください');
}

/**
 * 勤怠記録の「直行」「直帰」を勤務区間から写し直す（正は勤務区間）。
 * 時刻・実働などは計算し直さない（付帯情報の変更で過去の日の勤務時間が変わらないように）。
 */
function refreshDirectSummary_(record, timestamp) {
  const rows = getSegmentRowsOfAttendance_(String(record['勤怠ID']).trim());
  const summary = summarizeDaySegments_(getDaySegments_(record, rows));
  if (!summary) return;
  const fields = onlyExistingColumns_(SHEET_NAMES.ATTENDANCE, {
    '直行': summary.direct ? MARKS.YES : '',
    '直帰': summary.directReturn ? MARKS.YES : '',
  });
  if (Object.keys(fields).some(function (k) { return toPlainText_(record[k]) !== fields[k]; })) {
    fields['更新日時'] = timestamp;
    updateRecord_(SHEET_NAMES.ATTENDANCE, record, fields);
  }
}

/**
 * 「自家用車を業務で使用 ＋ ○km」を交通費明細の自家用車の行として保存する。
 *   その日の自家用車の行が 0件 → 使用なら1行作る（交通手段＝自家用車・自家用車使用＝○・業務走行距離＝km・金額＝空欄）
 *   1件 → 距離を書き換える／使用しないなら削除フラグ
 *   2件以上 → ここでは変えない（交通費カードで1件ずつ直す）
 */
function saveCarUsage_(staff, dateKey, car, record, now) {
  requireTransportSchema_();
  const rows = listTransportRows_(staff.employeeId, dateKey, dateKey).filter(function (r) { return toPlainText_(r['交通手段']) === TRANSPORT_MODE_CAR; });
  const use = car.use === true;
  if (rows.length >= 2) {
    const total = summarizeTransportItems_(rows.map(toTransportView_)).km;
    const km = use ? Number(parseTransportKm_(car.km, true)) : 0;
    if (use && Math.abs(km - total) < 0.05) return '';
    fail_('この日は自家用車の明細が ' + rows.length + '件あります（合計 ' + formatKm_(total) + '）。距離の修正・削除は「交通費」から1件ずつ行ってください');
  }
  if (!use) {
    if (!rows.length) return '';
    markTransportDeleted_(rows[0], now.timestamp);
    return '自家用車（使用しない）';
  }
  const km = parseTransportKm_(car.km, true);
  if (rows.length === 1) {
    if (String(transportNumber_(rows[0]['業務走行距離'])) === km) return '';
    updateRecord_(SHEET_NAMES.TRANSPORT, rows[0], { '業務走行距離': km, '自家用車使用': MARKS.YES, '更新日時': now.timestamp });
    return '自家用車の走行距離（' + km + 'km）';
  }
  appendTransportRow_(staff, {
    date: dateKey, mode: TRANSPORT_MODE_CAR, from: '', to: '',
    purpose: defaultCarPurpose_(record), amount: '', car: MARKS.YES, km: km, note: '',
  }, now.timestamp);
  return '自家用車の走行距離（' + km + 'km）';
}

/** 自動で作る自家用車の明細の「目的・現場」：その日の現場名（なければ「業務での自家用車使用」） */
function defaultCarPurpose_(record) {
  if (record) {
    const sites = getSegmentRowsOfAttendance_(String(record['勤怠ID']).trim())
      .map(function (r) { return toPlainText_(r['現場名']).trim(); })
      .filter(function (v, i, a) { return v && a.indexOf(v) === i; });
    if (sites.length) return sites.join('・').slice(0, TEXT_LIMITS.SHORT);
  }
  return '業務での自家用車使用';
}

/**
 * 1日の付帯情報（画面へ返す形）。本人（または管理者）の分だけに使うこと。
 * 戻り値：{ date, editable, hasAttendance, hasSegments, dayNote, businessTrip, direct, directReturn,
 *          segments: [{ number, style, start, end, direct, directReturn, site, note }],
 *          car: { km, count, use, single }, transports: [...], transportTotals }
 */
function buildMyDayDetail_(staff, dateKey, now) {
  const record = findAttendance_(staff.employeeId, dateKey);
  return buildDayDetailForEmployee_(staff.employeeId, dateKey, record, now);
}

function buildDayDetailForEmployee_(employeeId, dateKey, record, now) {
  const current = getPayrollPeriodForDate_(now.date);
  const editable = dateKey >= current.from && dateKey <= now.date;
  const segRows = record ? getSegmentRowsOfAttendance_(String(record['勤怠ID']).trim()) : [];
  const segments = record ? getDaySegments_(record, segRows) : [];
  const summary = segments.length ? summarizeDaySegments_(segments) : null;
  const transports = listTransportRows_(employeeId, dateKey, dateKey).map(toTransportView_);
  const carItems = transports.filter(function (t) { return t.mode === TRANSPORT_MODE_CAR; });
  const carTotal = summarizeTransportItems_(carItems);
  return {
    date: dateKey,
    editable: editable,
    periodText: current.periodText,
    hasAttendance: !!record,
    hasSegments: segRows.length > 0,
    dayNote: record ? toPlainText_(record['日備考']) : '',
    businessTrip: record ? !isBlank_(record['出張']) : false,
    // 勤務場所（会社＋在宅）と、付帯情報（直行・直帰・現場名）は分けて返す
    workPlace: workPlaceCategoryLabel_(workStyleCategory_(segments)),
    sites: segments.map(function (s) { return (s.site || '').trim(); }).filter(function (v, i, a) { return v && a.indexOf(v) === i; }),
    direct: !!(summary && summary.direct && segRows.length),
    directReturn: !!(summary && summary.directReturn && segRows.length),
    segments: segments.map(function (s) {
      return {
        number: s.number, style: s.style, place: workPlaceLabel_(s.style), legacy: punchWorkStyles_().indexOf(s.style) === -1,
        first: !!summary && segments.indexOf(s) === summary.firstIndex, // 直行を付けられるのはこの区間だけ
        start: minutesToClock_(s.startMinutes), end: s.endMinutes === null ? '' : minutesToClock_(s.endMinutes),
        direct: !!s.direct, directReturn: !!s.directReturn, site: s.site || '', note: s.note || '', virtual: s.virtual,
      };
    }),
    car: { use: carItems.length > 0, count: carItems.length, km: carTotal.km, kmText: carTotal.kmText, single: carItems.length === 1 ? carItems[0].expenseId : '' },
    transports: transports,
    transportTotals: summarizeTransportItems_(transports),
  };
}
