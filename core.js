// [가계부앱] 2026-11-20 : 계산·엑셀 변환 로직 (브라우저와 node 공용, 화면 코드 없음)
const Core = (() => {
  // 편한가계부 엑셀 내보내기와 같은 컬럼 (가져오기·내보내기 양쪽에서 사용)
  const HEADER = ['날짜', '자산', '분류', '소분류', '내용', 'KRW', '수입/지출', '태그', '메모', '금액', '화폐', '자산'];
  const EPOCH = Date.UTC(1899, 11, 30);

  const newState = () => ({
    v: 1, seq: 1,
    groups: ['현금', '은행', '카드', '체크카드', '선불식카드', '저축', '투자', '마이너스 통장', '대출', '보험', '기타'],
    assets: [], // { name, group, inTotal, hidden, deleted }
    cats: { 수입: [], 지출: [] },
    tx: [], // { id, ts, asset, cat, sub, note, amt, type: 수입|지출|이체, tag, memo }  이체는 asset=출금, cat=입금
    favs: [], memos: [],
    budgets: {}, // { 분류: 금액, 전체: 금액 }. 기본예산
    budgetM: {}, // { 분류: { 'YYYY-MM': 금액 } }. 그 달에만 쓰는 예산
    budRoll: {}, // [가계부앱] 2026-11-23 : { 분류: 'YYYY-MM' }. 이월을 켠 달. 그 달부터 (예산 - 지출)이 다음 달로 넘어간다
    subs: {}, // { 분류: [소분류, ...] } 분류 관리에서 정해 둔 소분류 목록
    routines: [], // { id, text, every: month|week|once, day, dow, date, since: 등록한 날, done: 마지막으로 체크한 회차 날짜 }
    repeats: [], // { id, every: week|month|year, start, n: 다음 회차 번호, tpl: 내역 틀 }
  });

  // 엑셀 날짜 일련번호 <-> 'YYYY-MM-DDTHH:MM:SS'. 시간대 변환 없이 적힌 시각 그대로 다룬다
  const serialToTs = n => new Date(Math.round(n * 86400) * 1000 + EPOCH).toISOString().slice(0, 19);
  const tsToSerial = ts => (Date.parse(ts + 'Z') - EPOCH) / 86400000;

  // 편한가계부 엑셀은 이모지를 &#x1f9e5; 같은 숫자 참조로 적는데, SheetJS 가 이를 16비트로 잘라 읽는다(U+1F9E5 -> U+F9E5). 잘린 글자를 되돌린다
  // ponytail: U+F000~U+FAFF 를 전부 이모지로 본다. 이 구간의 한자 호환 글자를 실제로 쓰게 되면 엑셀 XML 을 직접 읽는 방식으로 바꾼다
  const str = v => (v == null ? '' : String(v).replace(/[-﫿]/g, c => String.fromCodePoint(c.charCodeAt(0) + 0x10000)));

  function rowsToTx(rows) {
    return rows.slice(1).filter(r => r && r[0] != null && r[0] !== '').map((r, i) => {
      const type = r[6] === '이체출금' ? '이체' : r[6];
      if (!['수입', '지출', '이체'].includes(type)) throw new Error(`${i + 2}행: 알 수 없는 구분 "${r[6]}"`);
      return {
        ts: typeof r[0] === 'number' ? serialToTs(r[0]) : str(r[0]).replace(' ', 'T').slice(0, 19),
        asset: str(r[1]), cat: str(r[2]), sub: str(r[3]), note: str(r[4]),
        amt: Math.round(Number(r[5]) || 0), type, tag: str(r[7]), memo: str(r[8]),
        ...(r[10] && r[10] !== 'KRW' ? { cur: str(r[10]), famt: Number(r[9]) || 0 } : {}), // 외화로 적은 내역
      };
    });
  }

  const txToRows = state => [HEADER, ...[...state.tx].sort((a, b) => b.ts.localeCompare(a.ts)).map(t =>
    [tsToSerial(t.ts), t.asset, t.cat, t.sub || '', t.note, t.amt, t.type === '이체' ? '이체출금' : t.type, t.tag, t.memo, t.cur ? t.famt : t.amt, t.cur || 'KRW', t.amt])];

  const addAsset = (state, name, group = '기타') => {
    if (name && !state.assets.some(a => a.name === name)) state.assets.push({ name, group, inTotal: true, hidden: false, deleted: false });
  };
  const addCat = (state, type, cat) => {
    if (cat && state.cats[type] && !state.cats[type].includes(cat)) state.cats[type].push(cat);
  };

  // 내역을 파일 내용으로 바꾼다. 이미 있는 자산의 그룹·숨김·삭제 설정은 유지
  function importRows(state, rows) {
    state.tx = rowsToTx(rows).map(t => ({ id: state.seq++, ...t }));
    for (const t of state.tx) {
      addAsset(state, t.asset);
      if (t.type === '이체') addAsset(state, t.cat); else addCat(state, t.type, t.cat);
    }
    return state;
  }

  function balances(state) {
    const b = Object.fromEntries(state.assets.map(a => [a.name, 0]));
    const add = (k, v) => { b[k] = (b[k] || 0) + v; };
    for (const t of state.tx) {
      if (t.type === '수입') add(t.asset, t.amt);
      else { add(t.asset, -t.amt); if (t.type === '이체') add(t.cat, t.amt); }
    }
    return b;
  }

  // 삭제했거나 합계 제외로 둔 자산은 뺀다. 잔액이 음수인 자산이 부채
  function totals(state) {
    const b = balances(state);
    let assets = 0, liabilities = 0;
    for (const a of state.assets) {
      if (a.deleted || !a.inTotal) continue;
      const v = b[a.name] || 0;
      if (v >= 0) assets += v; else liabilities -= v;
    }
    return { assets, liabilities, net: assets - liabilities };
  }

  const sums = list => list.reduce((s, t) => {
    if (t.type === '수입') s.income += t.amt; else if (t.type === '지출') s.expense += t.amt;
    return s;
  }, { income: 0, expense: 0 });

  // prefix : '2026-11' (월) 또는 '2026' (연)
  const periodSums = (tx, prefix) => sums(tx.filter(t => t.ts.startsWith(prefix)));

  function byCategory(tx, prefix, type) {
    const m = {};
    for (const t of tx) if (t.type === type && t.ts.startsWith(prefix)) m[t.cat] = (m[t.cat] || 0) + t.amt;
    return Object.entries(m).sort((a, b) => b[1] - a[1]);
  }

  // [가계부앱] 2026-11-23 : 기간·주 단위 합계, 자산 상세(누적잔액), 카드 실적, 예산, 반복 내역 계산 추가
  // 날짜는 'YYYY-MM-DD' 문자열로만 다룬다 (시간대 영향 없음)
  const dAdd = (d, n) => new Date(Date.parse(d + 'T00:00:00Z') + n * 864e5).toISOString().slice(0, 10);
  const dow = d => new Date(d + 'T00:00:00Z').getUTCDay();
  const weekStart = d => dAdd(d, -dow(d)); // 일요일 시작
  const shiftYm = (ym, n) => { const [y, m] = ym.split('-').map(Number); return new Date(Date.UTC(y, m - 1 + n, 1)).toISOString().slice(0, 7); };
  const monthEnd = ym => dAdd(shiftYm(ym, 1) + '-01', -1);
  // 말일 보정 : 1/31 의 한 달 뒤는 2/28. 시작일 기준으로 계산해 날짜가 밀리지 않게 쓴다
  const addMonths = (ts, n) => {
    const [y, m, d] = ts.slice(0, 10).split('-').map(Number);
    const last = new Date(Date.UTC(y, m + n, 0)).getUTCDate();
    return new Date(Date.UTC(y, m - 1 + n, Math.min(d, last))).toISOString().slice(0, 10) + ts.slice(10);
  };
  const day = t => t.ts.slice(0, 10);
  const between = (tx, from, to) => tx.filter(t => day(t) >= from && day(t) <= to);
  // 그 달에 걸친 주 목록 [[일요일, 토요일], ...]
  const weeksOf = ym => { const out = []; for (let s = weekStart(ym + '-01'); s <= monthEnd(ym); s = dAdd(s, 7)) out.push([s, dAdd(s, 6)]); return out; };

  const catSums = (list, type) => {
    const m = {};
    for (const t of list) if (t.type === type) m[t.cat] = (m[t.cat] || 0) + t.amt;
    return Object.entries(m).sort((a, b) => b[1] - a[1]);
  };

  // 자산 하나의 수입·지출·이체입금·이체출금
  function flow(list, name) {
    const f = { income: 0, expense: 0, tin: 0, tout: 0 };
    for (const t of list) {
      if (t.type === '이체') { if (t.asset === name) f.tout += t.amt; if (t.cat === name) f.tin += t.amt; }
      else if (t.asset === name) f[t.type === '수입' ? 'income' : 'expense'] += t.amt;
    }
    return f;
  }

  // 자산 하나의 전체 내역을 시간순으로, 내역마다 증감(d)과 누적잔액(bal)을 붙여 돌려준다
  // ponytail: 같은 시각 내역끼리의 순서는 id 순. 원본 앱과 중간 누적잔액이 다르게 보이면 정렬 기준을 추가
  function ledger(state, name) {
    let bal = 0;
    return state.tx.filter(t => t.asset === name || (t.type === '이체' && t.cat === name))
      .sort((a, b) => a.ts.localeCompare(b.ts) || a.id - b.id)
      .map(t => { const d = t.type === '수입' || (t.type === '이체' && t.asset !== name) ? t.amt : -t.amt; bal += d; return { t, d, bal }; });
  }
  const balanceAt = (state, name, date) => ledger(state, name).filter(r => day(r.t) <= date).at(-1)?.bal || 0;

  // 카드 : 실적사용금액(ym 한 달), 결제예정금액, 미결제금액
  // ponytail: 결제예정 = 전월 말 미결제액 - 이번 달 입금액 으로 본다(1일~말일 사용, 다음 달 결제). 카드별 결제일·사용기간 설정이 필요해지면 자산에 기간 값을 둔다
  // ponytail: 할부는 내용 끝의 "(회차/개월)" 표기로 판단. 첫 회차에 전체(회차 금액 x 개월)를 실적으로 잡고 이후 회차는 뺀다
  function card(state, name, ym) {
    const L = ledger(state, name), prevEnd = dAdd(ym + '-01', -1), end = monthEnd(ym);
    const prev = L.filter(r => day(r.t) <= prevEnd).at(-1)?.bal || 0;
    const bal = L.filter(r => day(r.t) <= end).at(-1)?.bal || 0;
    const month = L.filter(r => r.t.ts.startsWith(ym));
    const paid = month.reduce((s, r) => s + (r.d > 0 ? r.d : 0), 0);
    const due = Math.max(0, -prev - paid);
    const perf = month.reduce((s, { t }) => {
      if (t.type !== '지출' || t.noPerf) return s;
      const m = /\((\d+)\/(\d+)\)\s*$/.exec(t.note);
      return s + (m ? (m[1] === '1' ? t.instTotal ?? t.amt * Number(m[2]) : 0) : t.amt);
    }, 0);
    return { perf, due, unpaid: Math.max(0, -bal) - due };
  }

  // 예산 : [{ cat, budget, spent, carry }]. 맨 앞이 전체. 전체예산은 항상 분류 예산의 합 (예전 자료의 budgets.전체 는 쓰지 않는다)
  // [가계부앱] 2026-11-23 : budget 은 그 달에 쓸 수 있는 금액 = 그 달 예산 + 이월(carry). 그 달 예산만 필요하면 budgetOf
  function budgetRows(state, ym) {
    const list = state.tx.filter(t => t.ts.startsWith(ym)), spent = Object.fromEntries(catSums(list, '지출'));
    const rows = budCats(state).map(cat => { const carry = carryOf(state, cat, ym); return { cat, budget: (budgetOf(state, cat, ym) || 0) + carry, spent: spent[cat] || 0, carry }; });
    const add = k => rows.reduce((s, r) => s + r[k], 0);
    return [{ cat: '전체', budget: add('budget'), spent: sums(list).expense, carry: add('carry') }, ...rows];
  }
  // [가계부앱] 2026-11-23 : 이월액. 이월을 켠 달부터 ym 전달까지 매달 (예산 - 지출) 누적. 초과도 그대로 빼서 넘긴다
  function carryOf(state, cat, ym) {
    const start = state.budRoll?.[cat];
    let s = 0;
    if (start) for (let m = start; m < ym; m = shiftYm(m, 1)) s += (budgetOf(state, cat, m) || 0) - (Object.fromEntries(catSums(state.tx.filter(t => t.ts.startsWith(m)), '지출'))[cat] || 0);
    return s;
  }
  // [가계부앱] 2026-11-23 : 예산 있는 분류를 지출 분류 순서대로 (분류 목록에 없는 건 뒤에, 넣은 순서)
  const budCats = state => { const order = state.cats?.지출 || [], rank = c => (order.indexOf(c) + 1 || 1e9); return Object.keys(state.budgets || {}).filter(c => c !== '전체').sort((a, b) => rank(a) - rank(b)); };
  // [가계부앱] 2026-11-23 : 그 달의 예산. 월별 예산을 따로 넣었으면 그 값, 아니면 기본예산
  const budgetOf = (state, cat, ym) => state.budgetM?.[cat]?.[ym] ?? state.budgets?.[cat];

  // [가계부앱] 2026-11-23 : 반복 종류 확장(매일·주중·주말·N주·월말·N개월), 할부 이자 계산 추가
  // 반복의 n 번째(0 부터) 날짜. 월 단위는 시작일 기준으로 계산해 말일 보정이 쌓이지 않게 한다
  const DAY_STEP = { day: 1, week: 7, '2week': 14, '4week': 28 }, MONTH_STEP = { month: 1, '2month': 2, '3month': 3, '4month': 4, '6month': 6, year: 12 };
  // [가계부앱] 2026-11-23 : 루틴 알림. 오늘 기준으로 가장 최근에 돌아온 회차 날짜를 돌려준다
  // 아직 안 왔거나, 등록하기 전 회차거나, 이미 체크한 회차면 null. 매월 31일처럼 없는 날은 그 달 말일로 본다
  // ponytail: 밀린 회차는 가장 최근 한 번만 보여 준다. 두 달 밀려도 한 줄이다
  function routineDue(r, today) {
    let d;
    if (r.every === 'once') d = r.date;
    else if (r.every === 'week') d = dAdd(today, -((dow(today) - r.dow + 7) % 7));
    else if (r.every === 'year') { const at = y => `${y}-${String(r.month).padStart(2, '0')}-01`, y = Number(today.slice(0, 4)); d = at(y) > today ? at(y - 1) : at(y); } // 매년 그 달 1일
    else {
      const at = ym => { const e = monthEnd(ym); return r.day >= Number(e.slice(8)) ? e : `${ym}-${String(r.day).padStart(2, '0')}`; };
      d = at(today.slice(0, 7));
      if (d > today) d = at(shiftYm(today.slice(0, 7), -1));
    }
    return d && d <= today && d >= (r.since || '') && d > (r.done || '') && !(r.until && d > r.until) ? d : null;
  }

  function repeatTs(r) {
    const d0 = r.start.slice(0, 10), tm = r.start.slice(10);
    if (DAY_STEP[r.every]) return dAdd(d0, DAY_STEP[r.every] * r.n) + tm;
    if (MONTH_STEP[r.every]) return addMonths(r.start, MONTH_STEP[r.every] * r.n);
    if (r.every === 'monthEnd') return monthEnd(shiftYm(d0.slice(0, 7), r.n)) + tm;
    // 주중·주말 : 시작일부터 세어 n 번째로 해당하는 날
    for (let d = d0, k = -1; ; d = dAdd(d, 1)) if ((dow(d) % 6 === 0) === (r.every === 'weekend') && ++k === r.n) return d + tm;
  }

  // 반복 내역 : now 까지 돌아온 회차를 내역으로 만든다. 만든 건수를 돌려준다
  function runRepeats(state, now) {
    let made = 0;
    for (const r of state.repeats || []) {
      for (;;) {
        const ts = repeatTs(r);
        if (ts > now) break;
        state.tx.push({ id: state.seq++, ...r.tpl, ts });
        r.n++; made++;
      }
    }
    return made;
  }

  // 할부 계획 : 원금은 개월 수로 똑같이 나누고(남는 금액은 첫 회차), 이자는 그 달 남은 원금 x 연이율 / 12 (카드 할부 수수료 계산 방식)
  // ponytail: 카드사마다 일할 계산·절사 방식이 달라 실제 청구액과 몇 원~몇십 원 차이가 날 수 있다. 정확히 맞춰야 하면 회차 금액을 직접 고친다
  function instPlan(amt, months, annualPct = 0) {
    const per = Math.floor(amt / months), out = [];
    for (let i = 0, left = amt; i < months; i++) {
      const principal = i ? per : amt - per * (months - 1);
      out.push({ principal, interest: Math.round(left * annualPct / 100 / 12) });
      left -= principal;
    }
    return out;
  }

  return { HEADER, newState, serialToTs, tsToSerial, rowsToTx, txToRows, addAsset, addCat, importRows, balances, totals, sums, periodSums, byCategory,
    dAdd, dow, weekStart, shiftYm, monthEnd, addMonths, between, weeksOf, catSums, flow, ledger, balanceAt, card, budgetRows, budgetOf, budCats, carryOf, runRepeats, repeatTs, instPlan, routineDue };
})();

if (typeof module !== 'undefined') module.exports = Core;
