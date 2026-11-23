// [가계부앱] 2026-11-20 : 계산·엑셀 변환 로직 (브라우저와 node 공용, 화면 코드 없음)
const Core = (() => {
  // 편한가계부 엑셀 내보내기와 같은 컬럼 (가져오기·내보내기 양쪽에서 사용)
  const HEADER = ['날짜', '자산', '분류', '소분류', '내용', 'KRW', '수입/지출', '태그', '메모', '금액', '화폐', '자산'];
  const EPOCH = Date.UTC(1899, 11, 30);

  const newState = () => ({
    v: 1, seq: 1,
    groups: ['현금', '은행', '카드', '저축', '투자', '기타'],
    assets: [], // { name, group, inTotal, hidden, deleted }
    cats: { 수입: [], 지출: [] },
    tx: [], // { id, ts, asset, cat, sub, note, amt, type: 수입|지출|이체, tag, memo }  이체는 asset=출금, cat=입금
    favs: [], memos: [],
    budgets: {}, // { 분류: 금액, 전체: 금액 }
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
      return s + (m ? (m[1] === '1' ? t.amt * Number(m[2]) : 0) : t.amt);
    }, 0);
    return { perf, due, unpaid: Math.max(0, -bal) - due };
  }

  // 예산 : [{ cat, budget, spent }]. 맨 앞이 전체. '전체' 예산을 따로 두지 않았으면 분류 예산의 합
  function budgetRows(state, ym) {
    const list = state.tx.filter(t => t.ts.startsWith(ym)), spent = Object.fromEntries(catSums(list, '지출'));
    const b = state.budgets || {}, cats = Object.keys(b).filter(c => c !== '전체');
    const total = b.전체 ?? cats.reduce((s, c) => s + b[c], 0);
    return [{ cat: '전체', budget: total, spent: sums(list).expense }, ...cats.map(cat => ({ cat, budget: b[cat], spent: spent[cat] || 0 }))];
  }

  // 반복 내역 : now 까지 돌아온 회차를 내역으로 만든다. 만든 건수를 돌려준다
  function runRepeats(state, now) {
    let made = 0;
    for (const r of state.repeats || []) {
      for (;;) {
        const ts = r.every === 'week' ? dAdd(r.start.slice(0, 10), 7 * r.n) + r.start.slice(10) : addMonths(r.start, (r.every === 'year' ? 12 : 1) * r.n);
        if (ts > now) break;
        state.tx.push({ id: state.seq++, ...r.tpl, ts });
        r.n++; made++;
      }
    }
    return made;
  }

  return { HEADER, newState, serialToTs, tsToSerial, rowsToTx, txToRows, addAsset, addCat, importRows, balances, totals, sums, periodSums, byCategory,
    dAdd, dow, weekStart, shiftYm, monthEnd, addMonths, between, weeksOf, catSums, flow, ledger, balanceAt, card, budgetRows, runRepeats };
})();

if (typeof module !== 'undefined') module.exports = Core;
