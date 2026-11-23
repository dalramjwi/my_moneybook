// [가계부앱] 2026-11-20 : 화면과 저장. 데이터는 이 기기의 IndexedDB 에만 둔다
// [가계부앱] 2026-11-23 : 팝업을 화면 전환으로 변경. 달력·월별·결산(예산)·필터·통계 기간·자산 상세·카드 실적·반복/할부·수수료·사진·외화·자산 메모 추가
const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const num = n => Math.round(n).toLocaleString('ko-KR');
const won = n => num(n) + '원';
const nowTs = () => { const d = new Date(); return new Date(d - d.getTimezoneOffset() * 60000).toISOString().slice(0, 19); };
const today = () => nowTs().slice(0, 10);
const DAYS = ['일', '월', '화', '수', '목', '금', '토'];
const cls = type => (type === '수입' ? 'in' : type === '지출' ? 'out' : 'tr');
const sign = v => (v > 0 ? 'in' : v < 0 ? 'out' : '');
const desc = (a, b) => b.ts.localeCompare(a.ts);
const hm = ts => { const h = Number(ts.slice(11, 13)); return `${h < 12 ? '오전' : '오후'} ${h % 12 || 12}:${ts.slice(14, 16)}`; };
const md = d => `${d.slice(5, 7)}.${d.slice(8, 10)}`; // 11.15
const sd = d => `${d.slice(2, 4)}.${Number(d.slice(5, 7))}.${Number(d.slice(8, 10))}`; // 26.11.1
const ymLabel = ym => `${ym.slice(0, 4)}년 ${Number(ym.slice(5))}월`;

// ponytail: 상태 전체를 IndexedDB 한 건으로 저장한다. 내역이 수만 건을 넘어 저장이 느려지면 내역만 별도 스토어로 분리
const idb = (mode, fn) => new Promise((res, rej) => {
  const open = indexedDB.open('my_moneybook', 1);
  open.onupgradeneeded = () => open.result.createObjectStore('kv');
  open.onerror = () => rej(open.error);
  open.onsuccess = () => {
    const tx = open.result.transaction('kv', mode);
    const req = fn(tx.objectStore('kv'));
    tx.oncomplete = () => res(req.result);
    tx.onerror = () => rej(tx.error);
  };
});
const save = () => idb('readwrite', s => s.put(S, 'state')).catch(e => alert('저장에 실패했습니다: ' + e));

let S;
const V = {
  tab: 'book', sub: 'day', ym: today().slice(0, 7), q: '', openMonth: today().slice(0, 7),
  statType: '지출', sMode: 'month', sDay: today(), sFrom: today().slice(0, 4) + '-01-01', sTo: today().slice(0, 4) + '-12-31',
  filter: { 수입: new Set(), 지출: new Set(), 자산: new Set() }, openMemo: new Set(),
  stack: [], // 탭 위에 쌓이는 화면 { p: 화면 이름, ... }
};

// ---------- 화면 전환 ----------
const topPg = () => V.stack.at(-1); // 이름을 top 으로 두면 브라우저의 window.top 과 겹쳐 스크립트가 통째로 실패한다
const go = pg => { V.stack.push(pg); history.pushState(null, ''); render(); };
const pop = () => { V.stack.pop(); render(); }; // 폰의 뒤로 가기(popstate)도 여기로 온다
const head = (title, right = '') => `<header><button class="ic" data-act="back" aria-label="뒤로">←</button><b class="grow">${esc(title)}</b>${right}</header>`;
const fab = (arg = '') => `<button class="fab" data-act="newTx" data-arg="${arg}" aria-label="내역 추가">+</button>`;

const monthNav = (act = 'month', label = ymLabel(V.ym)) => `<div class="month"><button data-act="${act}" data-arg="-1">‹</button><b>${label}</b><button data-act="${act}" data-arg="1">›</button></div>`;
const sumBox = (s, l = ['수입', '지출', '합계']) => `<div class="sum"><div>${l[0]}<b class="in">${num(s.income)}</b></div><div>${l[1]}<b class="out">${num(s.expense)}</b></div><div>${l[2]}<b>${num(s.income - s.expense)}</b></div></div>`;
const liveNames = () => S.assets.filter(a => !a.deleted).map(a => a.name);
const isCard = a => a.group.includes('카드');

// ---------- 가계부 ----------
// o.name : 자산 상세에서 볼 때 그 자산 기준으로 색을 정한다(들어오면 파랑, 나가면 빨강). o.bal : 내역 id -> 누적잔액
function txRow(t, o = {}) {
  const tr = t.type === '이체';
  const c = tr && o.name ? (t.cat === o.name ? 'in' : 'out') : cls(t.type);
  return `<li data-act="editTx" data-arg="${t.id}"><span class="c">${esc(tr ? '이체' : t.cat)}${t.sub ? `<small>${esc(t.sub)}</small>` : ''}</span>
    <span class="m"><b>${esc(t.note)}</b><small>${hm(t.ts)} ${esc(tr ? `${t.asset} → ${t.cat}` : t.asset)}${t.photo ? ' 📷' : ''}</small></span>
    <span class="a ${c}">${won(t.amt)}${t.cur ? `<small>${esc(t.cur)} ${Number(t.famt).toLocaleString('ko-KR')}</small>` : ''}${o.bal ? `<small>(${num(o.bal.get(t.id))})</small>` : ''}</span></li>`;
}

// 날짜별로 묶은 내역 목록. o.sum : 날짜 머리줄의 합계 계산 방법(기본은 수입·지출)
function dayList(list, o = {}) {
  const byDay = new Map();
  for (const t of list.slice(0, 500)) { const d = t.ts.slice(0, 10); byDay.set(d, [...(byDay.get(d) || []), t]); }
  let html = '';
  for (const [d, items] of byDay) {
    const s = (o.sum || Core.sums)(items), w = Core.dow(d);
    html += `<h3><b>${Number(d.slice(8))}</b><i class="wd w${w}">${DAYS[w]}요일</i><small>${d.slice(0, 4)}.${d.slice(5, 7)}</small><span class="in">${won(s.income)}</span><span class="out">${won(s.expense)}</span></h3><ul class="list">${items.map(t => txRow(t, o)).join('')}</ul>`;
  }
  if (!list.length) html += '<p class="empty">데이터가 없습니다.</p>';
  if (list.length > 500) html += '<p class="empty">최근 500건만 표시했습니다.</p>';
  return html;
}

const fActive = () => V.filter.수입.size + V.filter.지출.size + V.filter.자산.size > 0;
// 분류를 고르면 그 분류의 수입·지출만, 자산을 고르면 그 자산이 들어간 내역만 통과
function passes(t) {
  const f = V.filter;
  if (f.수입.size + f.지출.size && !(t.type !== '이체' && f[t.type].has(t.cat))) return false;
  if (f.자산.size && !(f.자산.has(t.asset) || (t.type === '이체' && f.자산.has(t.cat)))) return false;
  return true;
}

function viewDay() {
  const list = (V.q ? S.tx.filter(t => `${t.note} ${t.cat} ${t.sub || ''} ${t.asset} ${t.memo} ${t.tag}`.includes(V.q)) : S.tx.filter(t => t.ts.startsWith(V.ym))).filter(passes).sort(desc);
  return `<input type="search" class="search" placeholder="검색 (내용·분류·자산·메모)" value="${esc(V.q)}" data-change="search">
    ${fActive() ? '<p class="chip">필터 적용 중 <button data-act="fClear">해제</button></p>' : ''}${sumBox(Core.sums(list))}${dayList(list)}`;
}

function viewCal() {
  const first = V.ym + '-01', end = Core.monthEnd(V.ym), by = {};
  const list = S.tx.filter(t => t.ts.startsWith(V.ym));
  for (const t of list) if (t.type !== '이체') { const o = by[t.ts.slice(0, 10)] ||= { 수입: 0, 지출: 0 }; o[t.type] += t.amt; }
  let cells = '<i></i>'.repeat(Core.dow(first));
  for (let d = first; d <= end; d = Core.dAdd(d, 1)) {
    const o = by[d] || {};
    cells += `<button data-act="dayList" data-arg="${d}"${d === today() ? ' class="today"' : ''}><b>${Number(d.slice(8))}</b>${o.수입 ? `<small class="in">${num(o.수입)}</small>` : ''}${o.지출 ? `<small class="out">${num(o.지출)}</small>` : ''}</button>`;
  }
  return `${sumBox(Core.sums(list))}<div class="cal">${DAYS.map(d => `<em>${d}</em>`).join('')}${cells}</div>`;
}

// 월별 : 그 해의 달 목록. 달을 누르면 주 단위(일~토)로 펼친다
function viewMonth() {
  const y = V.ym.slice(0, 4), cur = today().slice(0, 7), t0 = today();
  const cell = s => `<span class="a in">${won(s.income)}</span><span class="a"><span class="out">${won(s.expense)}</span><small>${won(s.income - s.expense)}</small></span>`;
  let html = sumBox(Core.periodSums(S.tx, y)) + '<ul class="list">';
  for (let m = 12; m >= 1; m--) {
    const ym = `${y}-${String(m).padStart(2, '0')}`, s = Core.periodSums(S.tx, ym);
    if (ym > cur && !s.income && !s.expense) continue;
    html += `<li data-act="openMonth" data-arg="${ym}"><span class="m"><b class="big">${m}월</b>${V.openMonth === ym ? `<small>${md(ym + '-01')} ~ ${md(Core.monthEnd(ym))}</small>` : ''}</span>${cell(s)}</li>`;
    if (V.openMonth === ym) for (const [f, t] of Core.weeksOf(ym).reverse())
      html += `<li class="wk${t0 >= f && t0 <= t ? ' now' : ''}" data-act="range" data-arg="${f},${t}"><span class="m">${md(f)} ~ ${md(t)}</span>${cell(Core.sums(Core.between(S.tx, f, t)))}</li>`;
  }
  return html + '</ul>';
}

// 결산 : 예산 대비 지출. 세로선은 오늘 위치(그 달의 며칠째인지)
function viewBudget() {
  const rows = Core.budgetRows(S, V.ym), t = today();
  const pos = t.startsWith(V.ym) ? Number(t.slice(8)) / Number(Core.monthEnd(V.ym).slice(8)) * 100 : null;
  const bar = r => {
    const p = r.budget ? Math.floor(r.spent / r.budget * 100) : 0, over = r.spent > r.budget;
    return `<li class="bud"><div class="bl"><small>${esc(r.cat === '전체' ? '전체예산' : r.cat)}</small><b>${won(r.budget)}</b></div>
      <div class="br"><div class="bar${over ? ' over' : ''}"><i style="width:${Math.min(p, 100)}%"></i>${pos == null ? '' : `<u style="left:${pos}%"></u>`}<span>${r.budget ? p + '%' : '-'}</span></div>
      <div class="bv"><span class="${over ? 'out' : 'in'}">${won(r.spent)}</span><span>${over ? '초과 ' : ''}${won(r.budget - r.spent)}</span></div></div></li>`;
  };
  return `${sumBox(Core.periodSums(S.tx, V.ym))}<h3 class="plain"><b>예산</b><span><button data-act="go" data-arg="budgetSet">예산설정 ›</button></span></h3>
    ${rows.length > 1 || rows[0].budget ? `<ul class="list">${rows.map(bar).join('')}</ul>` : '<p class="empty">예산설정에서 분류별 예산을 넣으면 여기에 표시됩니다.</p>'}`;
}

const viewMemo = () => `<form data-form="memo" class="pad"><textarea name="text" rows="3" placeholder="메모" required></textarea><button class="pri">추가</button></form>
  <ul class="memo">${S.memos.map(m => `<li><pre>${esc(m.text)}</pre><button data-act="delMemo" data-arg="${m.id}">삭제</button></li>`).join('')}</ul>`;

function viewBook() {
  const tabs = [['day', '일일'], ['cal', '달력'], ['month', '월별'], ['budget', '결산'], ['memo', '메모']].map(([k, n]) => `<button data-act="sub" data-arg="${k}"${V.sub === k ? ' class="on"' : ''}>${n}</button>`).join('');
  return `<header>${monthNav('month', V.sub === 'month' ? V.ym.slice(0, 4) + '년' : ymLabel(V.ym))}<span><button data-act="go" data-arg="favs">자주사용</button> <button data-act="go" data-arg="filter"${fActive() ? ' class="on"' : ''}>필터</button></span></header>
    <div class="tabs">${tabs}</div>${{ day: viewDay, cal: viewCal, month: viewMonth, budget: viewBudget, memo: viewMemo }[V.sub]()}${fab()}`;
}

function pageList(pg) {
  const list = Core.between(S.tx, pg.from, pg.to).filter(t => !pg.cat || (t.type === pg.type && t.cat === pg.cat)).sort(desc);
  return head(pg.title) + sumBox(Core.sums(list)) + dayList(list) + fab(pg.from === pg.to ? pg.from : '');
}

function pageFilter(pg) {
  const all = S.tx.filter(t => t.ts.startsWith(V.ym)), tot = Core.sums(all), on = fActive(), sel = Core.sums(on ? all.filter(passes) : []);
  const ring = (label, c, a, b) => { const p = b ? Math.round(a / b * 100) : 0; return `<div class="ring"><small>${label}</small><div style="background:conic-gradient(var(--${c}) ${p}%, var(--line) 0)"><b>${p}%</b></div><span>${won(on ? a : b)}</span></div>`; };
  const chk = (k, v, cells) => `<label class="frowc"><input type="checkbox" data-change="fchk" data-k="${k}" value="${esc(v)}"${V.filter[k].has(v) ? ' checked' : ''}><span class="m">${esc(v)}</span>${cells}</label>`;
  let body;
  if (pg.tab === '자산') {
    const live = S.assets.filter(a => !a.deleted && !a.hidden);
    body = `<p class="cap"><span class="in">수입</span>·이체입금 / <span class="out">지출</span>·이체출금</p>` + [...new Set(live.map(a => a.group))].map(g => `<h3>${esc(g)}</h3>` + live.filter(a => a.group === g).map(a => {
      const f = Core.flow(all, a.name);
      return chk('자산', a.name, `<span class="a"><span class="in">${won(f.income)}</span><small>${won(f.tin)}</small></span><span class="a"><span class="out">${won(f.expense)}</span><small>${won(f.tout)}</small></span>`);
    }).join('')).join('');
  } else {
    const amt = Object.fromEntries(Core.catSums(all, pg.tab));
    body = S.cats[pg.tab].map(c => chk(pg.tab, c, `<span class="a ${cls(pg.tab)}">${won(amt[c] || 0)}</span>`)).join('');
  }
  return `${head('필터', '<button data-act="fClear">해제</button>')}<header>${monthNav()}</header>
    <div class="rings">${ring('수입', 'in', sel.income, tot.income)}${ring('지출', 'out', sel.expense, tot.expense)}<div class="ring"><small>합계</small><span>${won((on ? sel : tot).income - (on ? sel : tot).expense)}</span></div></div>
    <div class="tabs">${['수입', '지출', '자산'].map(k => `<button data-act="ptab" data-arg="${k}"${pg.tab === k ? ' class="on"' : ''}>${k}</button>`).join('')}</div>${body}
    <div class="pad"><button class="pri" data-act="back">적용</button></div>`;
}

function pageBudgetSet() {
  const inp = (c, label) => `<label class="frow"><span>${esc(label)}</span><input type="number" inputmode="numeric" min="0" name="b:${esc(c)}" value="${S.budgets[c] ?? ''}" placeholder="없음"></label>`;
  return `${head('예산설정')}<form data-form="budget" class="form"><p class="cap">금액을 비우면 그 분류는 예산에서 빠집니다. 전체예산을 비우면 분류 예산의 합을 씁니다.</p>
    ${inp('전체', '전체예산')}<div class="gap"></div>${S.cats.지출.map(c => inp(c, c)).join('')}<div class="row"><button class="pri">저장하기</button></div></form>`;
}

// ---------- 내역 입력 ----------
function openTx(init) {
  if (!liveNames().length) return alert('자산 탭에서 자산을 먼저 추가하세요.');
  go({ p: 'tx', t: { type: '지출', ts: nowTs(), ...init } });
}

function pageTx(pg) {
  const t = { asset: '', cat: '', sub: '', note: '', amt: '', tag: '', memo: '', ...pg.t }, tr = t.type === '이체', names = liveNames();
  const opts = (arr, sel, ph) => (ph ? `<option value="">${ph}</option>` : '') + [...new Set([...arr, sel].filter(Boolean))].map(n => `<option${n === sel ? ' selected' : ''}>${esc(n)}</option>`).join('');
  t.asset ||= names[0];
  if (tr && !t.cat) t.cat = names.find(n => n !== t.asset) || ''; // 입금 기본값이 출금과 같지 않게
  const notes = [...new Set([...S.tx].sort(desc).slice(0, 300).map(x => x.note).filter(Boolean))];
  const subs = [...new Set(S.tx.filter(x => x.cat === t.cat && x.sub).map(x => x.sub))];
  const dl = (id, arr) => `<datalist id="${id}">${arr.map(x => `<option value="${esc(x)}">`).join('')}</datalist>`;
  const row = (label, inner) => `<label class="frow"><span>${label}</span>${inner}</label>`;
  const txt = (name, extra = '') => `<input name="${name}" value="${esc(t[name])}" ${extra}>`;
  const n = (name, ph = '') => `<input type="number" step="any" inputmode="decimal" name="${name}" value="${esc(t[name])}" placeholder="${ph}">`;
  return `${head(t.type)}<form data-form="tx" class="form t-${cls(t.type)}">
    <input type="hidden" name="id" value="${t.id ?? ''}"><input type="hidden" name="photo" value="${t.photo || ''}">
    <div class="seg">${['수입', '지출', '이체'].map(k => `<label><input type="radio" name="type" value="${k}" data-change="txType"${k === t.type ? ' checked' : ''}><span class="${cls(k)}">${k}</span></label>`).join('')}</div>
    ${row('날짜', `<input type="datetime-local" name="ts" value="${t.ts.slice(0, 16)}" required>`)}
    ${row('금액', `<input type="number" name="amt" inputmode="numeric" min="1" value="${t.amt}" placeholder="원">`)}
    ${tr ? row('출금', `<select name="asset">${opts(names, t.asset)}</select>`) + row('입금', `<select name="cat">${opts(names, t.cat)}</select>`)
      : row('분류', `<select name="cat" data-change="txType" required>${opts(S.cats[t.type] || [], t.cat, '선택')}</select>`) + row('소분류', txt('sub', 'list="dl-sub" placeholder="선택 사항"')) + row('자산', `<select name="asset">${opts(names, t.asset)}</select>`)}
    ${row('내용', txt('note', 'list="dl-note"'))}${dl('dl-sub', subs)}${dl('dl-note', notes)}
    <div class="gap"></div>
    ${row('태그', txt('tag'))}${row('메모', `<textarea name="memo" rows="2">${esc(t.memo)}</textarea>`)}
    <div class="frow"><span>사진</span><div>${t.photo ? `<img class="photo" src="${t.photo}" alt="첨부 사진"><button type="button" data-act="rmPhoto">사진 삭제</button>` : '<input type="file" accept="image/*" data-change="photo">'}</div></div>
    ${t.type === '지출' ? `<label class="chk"><input type="checkbox" name="noPerf"${t.noPerf ? ' checked' : ''}>카드 실적에서 제외</label>` : ''}
    <details${t.cur ? ' open' : ''}><summary>외화로 적기</summary><p class="cap">금액(원)을 비우면 외화 금액 × 환율로 계산합니다.</p>
      ${row('화폐', txt('cur', 'placeholder="JPY" maxlength="3"'))}${row('외화 금액', n('famt'))}${row('환율', n('rate', '1단위당 원'))}</details>
    ${t.id ? '' : `<details${t.rep || t.fee ? ' open' : ''}><summary>반복/할부${tr ? ' · 수수료' : ''}</summary>
      ${row('반복', `<select name="rep">${[['', '안 함'], ['week', '매주'], ['month', '매월'], ['year', '매년'], ['inst', '할부']].map(([k, l]) => `<option value="${k}"${t.rep === k ? ' selected' : ''}>${l}</option>`).join('')}</select>`)}
      ${row('할부 개월', n('months', '할부일 때만'))}${tr ? row('수수료', n('fee', '출금 자산에서 지출')) : ''}</details>`}
    <div class="row"><button class="pri" name="go" value="save">저장하기</button>${t.id ? '' : '<button name="go" value="more">계속</button>'}</div>
    ${t.id ? `<div class="row"><button type="button" data-act="delTx" data-arg="${t.id}">삭제</button><button type="button" data-act="copyTx" data-arg="${t.id}">복사</button><button type="button" data-act="favTx" data-arg="${t.id}">자주사용</button></div>` : ''}
  </form>`;
}

// 입력 중인 폼 값을 그대로 읽는다 (구분을 바꾸거나 사진을 붙여 화면을 다시 그릴 때 유지)
const formVals = f => { const v = Object.fromEntries(new FormData(f)); return { ...v, id: Number(v.id) || undefined, noPerf: !!v.noPerf }; };

function saveTx(v) {
  let amt = Math.round(Number(v.amt));
  const cur = (v.cur || '').trim().toUpperCase(), famt = Number(v.famt);
  if (!(amt > 0) && cur && famt > 0 && Number(v.rate) > 0) amt = Math.round(famt * Number(v.rate));
  if (!(amt > 0)) return alert('금액을 확인하세요.');
  if (v.type === '이체' && v.asset === v.cat) return alert('출금과 입금 자산이 같습니다.');
  const old = S.tx.find(x => x.id === Number(v.id)), tr = v.type === '이체';
  const t = { id: old ? old.id : S.seq++, ts: v.ts.length === 16 ? v.ts + ':00' : v.ts, asset: v.asset, cat: v.cat.trim(), sub: tr ? '' : (v.sub ?? old?.sub ?? '').trim(), note: v.note.trim(), amt, type: v.type, tag: v.tag.trim(), memo: v.memo.trim() };
  if (cur && famt > 0) Object.assign(t, { cur, famt });
  if (v.photo) t.photo = v.photo;
  if (v.noPerf && !tr) t.noPerf = true;
  const months = Math.round(Number(v.months));
  if (old) S.tx[S.tx.indexOf(old)] = t;
  else if (v.rep === 'inst' && months > 1) { // 할부 : 달마다 한 건씩, 내용 끝에 (회차/개월). 나누고 남는 금액은 첫 회차에
    const per = Math.floor(amt / months);
    for (let i = 0; i < months; i++) S.tx.push({ ...t, id: i ? S.seq++ : t.id, ts: Core.addMonths(t.ts, i), amt: i ? per : amt - per * (months - 1), note: `${t.note}(${i + 1}/${months})` });
  } else {
    S.tx.push(t);
    if (['week', 'month', 'year'].includes(v.rep)) { // 첫 회차는 방금 저장했으니 n=1 부터
      const { id, ts, photo, ...tpl } = t;
      S.repeats.push({ id: S.seq++, every: v.rep, start: t.ts, n: 1, tpl });
      Core.runRepeats(S, nowTs());
    }
    if (tr && Number(v.fee) > 0) { S.tx.push({ ...t, id: S.seq++, type: '지출', cat: '기타', sub: '', note: '수수료', amt: Math.round(Number(v.fee)) }); Core.addCat(S, '지출', '기타'); }
  }
  if (!tr) Core.addCat(S, t.type, t.cat);
  V.ym = t.ts.slice(0, 7);
  if (v.go === 'more') { save(); topPg().t = { type: t.type, ts: t.ts, asset: t.asset }; render(); } else done();
}

const pageFavs = () => `${head('자주 사용하는 내역')}<ul class="list">${S.favs.map((f, i) => `<li data-act="useFav" data-arg="${i}"><span class="c">${esc(f.type === '이체' ? '이체' : f.cat)}</span>
  <span class="m"><b>${esc(f.note)}</b><small>${esc(f.type === '이체' ? `${f.asset} → ${f.cat}` : f.asset)}</small></span><span class="a ${cls(f.type)}">${won(f.amt)}</span>
  <button data-act="delFav" data-arg="${i}">삭제</button></li>`).join('') || '<p class="empty">내역 상세의 "자주사용"으로 추가합니다.</p>'}</ul>`;

// ---------- 통계 ----------
const PAL = ['#ff6f61', '#ff9a4d', '#ffcf40', '#ffe600', '#c3e84a', '#6fd36f', '#5fe3d6', '#6aaef0', '#a48be0', '#e88ad8', '#f06292', '#bdbdbd'];
function statPeriod() {
  const d = V.sDay, y = d.slice(0, 4), ym = d.slice(0, 7);
  if (V.sMode === 'week') { const f = Core.weekStart(d), t = Core.dAdd(f, 6); return [f, t, `${f.slice(2, 4)}.${md(f)} ~ ${t.slice(2, 4)}.${md(t)}`]; }
  if (V.sMode === 'year') return [y + '-01-01', y + '-12-31', y + '년'];
  if (V.sMode === 'range') return [V.sFrom, V.sTo, ''];
  return [ym + '-01', Core.monthEnd(ym), ymLabel(ym)];
}

function viewStats() {
  const [from, to, label] = statPeriod(), list = Core.between(S.tx, from, to), s = Core.sums(list);
  const rows = Core.catSums(list, V.statType), total = rows.reduce((a, r) => a + r[1], 0);
  const color = i => PAL[i % PAL.length];
  let acc = 0;
  const stops = rows.map(([, v], i) => { const f = acc; acc += v / total * 100; return `${color(i)} ${f}% ${acc}%`; });
  const nav = V.sMode === 'range' ? `<div class="month"><input type="date" value="${from}" data-change="sFrom">~<input type="date" value="${to}" data-change="sTo"></div>` : monthNav('sNav', label);
  return `<header>${nav}<select data-change="sMode">${[['week', '주간'], ['month', '월간'], ['year', '연간'], ['range', '기간']].map(([k, l]) => `<option value="${k}"${V.sMode === k ? ' selected' : ''}>${l}</option>`).join('')}</select></header>
    <div class="tabs">${['수입', '지출'].map(k => `<button data-act="stat" data-arg="${k}"${V.statType === k ? ' class="on"' : ''}>${k} ${won(k === '수입' ? s.income : s.expense)}</button>`).join('')}</div>
    ${total ? `<div class="pie" style="background:conic-gradient(${stops.join(',')})"></div>` : '<p class="empty">데이터가 없습니다.</p>'}
    <ul class="list">${rows.map(([c, v], i) => `<li data-act="statCat" data-arg="${esc(c)}"><span class="pct" style="background:${color(i)}">${Math.round(v / total * 100)}%</span><span class="m"><b>${esc(c)}</b></span><span class="a">${won(v)}</span></li>`).join('')}</ul>`;
}

// ---------- 자산 ----------
function viewAssets() {
  const bal = Core.balances(S), tot = Core.totals(S), ym = today().slice(0, 7);
  const cards = Object.fromEntries(S.assets.filter(isCard).map(a => [a.name, Core.card(S, a.name, ym)]));
  const row = a => {
    const v = bal[a.name] || 0, c = cards[a.name], open = V.openMemo.has(a.name);
    return `<li data-act="asset" data-arg="${esc(a.name)}"><span class="m"><b>${esc(a.name)}</b>${a.deleted ? '<small>삭제됨</small>' : a.hidden ? '<small>숨김</small>' : ''}</span>
      ${a.memo ? `<button class="ic sm" data-act="memoTog" data-arg="${esc(a.name)}" aria-label="메모 ${open ? '접기' : '펼치기'}">${open ? '−' : '+'}</button>` : ''}
      ${c && !a.deleted ? `<span class="a">${won(c.due)}</span><span class="a out">${won(c.unpaid)}</span>` : `<span class="a ${sign(v)}">${won(v)}</span>`}</li>
      ${a.memo && open ? `<li class="note"><pre>${esc(a.memo)}</pre></li>` : ''}`;
  };
  const live = S.assets.filter(a => !a.deleted && !a.hidden), rest = S.assets.filter(a => a.deleted || a.hidden);
  const groups = [...new Set([...S.groups, ...live.map(a => a.group)])];
  const gHead = (g, items) => {
    if (!items.every(isCard)) { const v = items.reduce((s, a) => s + (bal[a.name] || 0), 0); return `<h3>${esc(g)}<span class="${sign(v)}">${won(v)}</span></h3>`; }
    const sum = k => items.reduce((s, a) => s + cards[a.name][k], 0);
    return `<h3>${esc(g)}<span>결제예정 ${won(sum('due'))}</span><span class="out">미결제 ${won(sum('unpaid'))}</span></h3>`;
  };
  return `<header><b>자산</b><span><button data-act="go" data-arg="trend">추이</button> <button data-act="newAsset">추가</button></span></header>
    <div class="sum"><div>자산<b class="in">${num(tot.assets)}</b></div><div>부채<b class="out">${num(tot.liabilities)}</b></div><div>합계<b>${num(tot.net)}</b></div></div>
    ${groups.map(g => { const items = live.filter(a => a.group === g); return items.length ? `${gHead(g, items)}<ul class="list">${items.map(row).join('')}</ul>` : ''; }).join('')}
    ${rest.length ? `<details><summary>숨김·삭제된 자산 ${rest.length}개 (삭제된 자산은 합계에서 제외)</summary><ul class="list">${rest.map(row).join('')}</ul></details>` : ''}`;
}

// 자산 상세 : 일일(누적잔액 포함) · 월별 · 연별
function pageAsset(pg) {
  const a = S.assets.find(x => x.name === pg.name);
  if (!a) return head('자산') + '<p class="empty">자산이 없습니다.</p>';
  const L = Core.ledger(S, a.name), y = pg.ym.slice(0, 4);
  const tabs = `<div class="tabs">${[['day', '일일'], ['month', '월별'], ['year', '연별']].map(([k, n]) => `<button data-act="ptab" data-arg="${k}"${pg.tab === k ? ' class="on"' : ''}>${n}</button>`).join('')}</div>`;
  const tools = `<span><button data-act="trendOf">추이</button> <button data-act="assetInfo" aria-label="자산 정보 수정">✎</button></span>`;
  if (pg.tab !== 'day') { // 월·연 단위로 묶어 입금·출금·기말 잔액
    const n = pg.tab === 'month' ? 7 : 4, m = new Map();
    for (const r of L) { const k = r.t.ts.slice(0, n), o = m.get(k) || { inn: 0, out: 0 }; if (r.d > 0) o.inn += r.d; else o.out -= r.d; o.bal = r.bal; m.set(k, o); }
    const rows = [...m].reverse().filter(([k]) => pg.tab === 'year' || k.startsWith(y));
    return `${head(a.name, pg.tab === 'month' ? monthNav('pmonth', y + '년') : '')}${tabs}<p class="cap">입금 / 출금 / 잔액</p>
      <ul class="list">${rows.map(([k, o]) => `<li><span class="m"><b>${pg.tab === 'month' ? Number(k.slice(5)) + '월' : k + '년'}</b></span><span class="a in">${won(o.inn)}</span><span class="a out">${won(o.out)}</span><span class="a ${sign(o.bal)}">${won(o.bal)}</span></li>`).join('') || '<p class="empty">데이터가 없습니다.</p>'}</ul>`;
  }
  const from = pg.ym + '-01', to = Core.monthEnd(pg.ym), rows = L.filter(r => r.t.ts.startsWith(pg.ym));
  const list = rows.map(r => r.t).reverse(), inn = rows.reduce((s, r) => s + (r.d > 0 ? r.d : 0), 0), out = rows.reduce((s, r) => s + (r.d < 0 ? -r.d : 0), 0);
  const cum = Core.balanceAt(S, a.name, to), c = isCard(a) ? Core.card(S, a.name, pg.ym) : null;
  const sum = items => { const f = Core.flow(items, a.name); return { income: f.income + f.tin, expense: f.expense + f.tout }; };
  return `${head(a.name, monthNav('pmonth', ymLabel(pg.ym)))}${tabs}
    <h3 class="plain"><small>사용기간</small> <b class="mid">${sd(from)} ~ ${sd(to)}</b>${tools}</h3>
    <div class="sum"><div>입금<b class="in">${num(inn)}</b></div><div>출금<b class="out">${num(out)}</b></div><div>합계<b>${num(inn - out)}</b></div><div>누적잔액<b class="${sign(cum)}">${num(cum)}</b></div></div>
    ${c && a.perf ? `<div class="sum perf"><div>실적 기준<b>${won(a.perf)}</b></div><div>실적사용금액<b>${won(c.perf)}</b></div><div>남은금액<b>${won(Math.max(0, a.perf - c.perf))}</b></div></div>` : ''}
    ${a.memo ? `<pre class="note">${esc(a.memo)}</pre>` : ''}
    ${dayList(list, { name: a.name, bal: new Map(L.map(r => [r.t.id, r.bal])), sum })}
    ${c ? '<button class="fab two" data-act="pay">결제</button>' : ''}${fab()}`;
}

function pageAssetInfo(pg) {
  const a = S.assets.find(x => x.name === pg.name) || { name: '', group: S.groups[0], inTotal: true, hidden: false, deleted: false };
  const name = pg.name || '', row = (label, inner) => `<label class="frow"><span>${label}</span>${inner}</label>`;
  return `${head(name ? '자산정보' : '자산 추가')}<form data-form="asset" class="form">
    <input type="hidden" name="orig" value="${esc(name)}">
    ${row('그룹', `<select name="group">${[...new Set([...S.groups, a.group])].map(g => `<option${g === a.group ? ' selected' : ''}>${esc(g)}</option>`).join('')}</select>`)}
    ${row('이름', `<input name="name" value="${esc(a.name)}" required>`)}
    ${row('금액', `<input type="number" name="bal" inputmode="numeric" value="${name ? Core.balances(S)[name] || 0 : ''}" placeholder="현재 잔액">`)}
    ${row('메모', `<textarea name="memo" rows="3" placeholder="금리 조건, 우대 종료일 등">${esc(a.memo || '')}</textarea>`)}
    ${row('카드 실적 기준', `<input type="number" name="perf" inputmode="numeric" value="${a.perf || ''}" placeholder="카드만. 예: 300000">`)}
    <p class="cap">금액을 바꾸면 차액이 "잔액수정" 내역으로 들어갑니다.</p>
    <label class="chk"><input type="checkbox" name="inTotal"${a.inTotal ? ' checked' : ''}>합계에 반영</label>
    <label class="chk"><input type="checkbox" name="hidden"${a.hidden ? ' checked' : ''}>목록에서 숨김</label>
    <div class="row"><button class="pri">저장하기</button></div>
    ${name ? `<div class="row"><button type="button" data-act="moveAsset" data-arg="-1">순서 위로</button><button type="button" data-act="moveAsset" data-arg="1">순서 아래로</button><button type="button" data-act="toggleDel">${a.deleted ? '복원' : '삭제 (내역은 남음)'}</button></div>` : ''}
  </form>`;
}

function saveAsset(v) {
  const name = v.name.trim();
  if (!name) return;
  if (name !== v.orig && S.assets.some(a => a.name === name)) return alert('같은 이름의 자산이 있습니다.');
  const a = S.assets.find(x => x.name === v.orig);
  if (!a) Core.addAsset(S, name, v.group);
  const cur = S.assets.find(x => x.name === (a ? v.orig : name));
  Object.assign(cur, { name, group: v.group, inTotal: !!v.inTotal, hidden: !!v.hidden, memo: (v.memo ?? cur.memo ?? '').trim(), perf: Math.round(Number(v.perf ?? cur.perf)) || 0 });
  if (a && name !== v.orig) {
    for (const t of [...S.tx, ...S.favs, ...S.repeats.map(r => r.tpl)]) { // 이름을 바꾸면 내역의 자산 이름도 같이 바꾼다
      if (t.asset === v.orig) t.asset = name;
      if (t.type === '이체' && t.cat === v.orig) t.cat = name;
    }
    for (const pg of V.stack) if (pg.name === v.orig) pg.name = name;
  }
  if (v.bal != null && v.bal !== '') { // 금액을 직접 고치면 차액을 내역으로 남긴다
    const diff = Math.round(Number(v.bal)) - (Core.balances(S)[name] || 0);
    if (diff) { S.tx.push({ id: S.seq++, ts: nowTs(), asset: name, cat: '잔액수정', sub: '', note: '잔액 수정', amt: Math.abs(diff), type: diff > 0 ? '수입' : '지출', tag: '', memo: '' }); Core.addCat(S, diff > 0 ? '수입' : '지출', '잔액수정'); }
  }
  done();
}

// 최근 12개월 월말 기준 추이. pg.name 이 있으면 그 자산의 잔액, 없으면 전체 합계
function pageTrend(pg) {
  const cur = today().slice(0, 7), pts = [];
  for (let i = 11; i >= 0; i--) {
    const ym = Core.shiftYm(cur, -i), end = Core.monthEnd(ym), st = { ...S, tx: S.tx.filter(t => t.ts.slice(0, 10) <= end) };
    pts.push([ym, pg.name ? Core.balances(st)[pg.name] || 0 : Core.totals(st).net]);
  }
  const vals = pts.map(p => p[1]), lo = Math.min(0, ...vals), hi = Math.max(1, ...vals), W = 330, H = 150;
  const xy = (v, i) => `${15 + i * (W - 30) / 11},${10 + (H - 20) * (1 - (v - lo) / (hi - lo))}`;
  return `${head(pg.name ? `${pg.name} 추이` : '자산 합계 추이')}<p class="cap">최근 12개월, 월말 기준</p>
    <svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="월별 추이 그래프"><line x1="0" x2="${W}" y1="${xy(0, 0).split(',')[1]}" y2="${xy(0, 0).split(',')[1]}"/><polyline points="${vals.map(xy).join(' ')}"/>${vals.map((v, i) => `<circle cx="${xy(v, i).split(',')[0]}" cy="${xy(v, i).split(',')[1]}" r="3"/>`).join('')}</svg>
    <ul class="list">${pts.reverse().map(([ym, v]) => `<li><span class="m">${ymLabel(ym)}</span><span class="a ${sign(v)}">${won(v)}</span></li>`).join('')}</ul>`;
}

// ---------- 더보기 ----------
const EVERY = { week: '매주', month: '매월', year: '매년' };
const viewMore = () => `<header><b>더보기</b></header><div class="pad">
  <p>내역 ${num(S.tx.length)}건 · 자산 ${S.assets.filter(a => !a.deleted).length}개. 데이터는 이 기기에만 저장됩니다.</p>
  <h3>엑셀</h3>
  <button data-act="pick" data-arg="fx">엑셀 가져오기 (내역 전체 교체)</button>
  <button data-act="exportXlsx">엑셀 내보내기</button>
  <h3>백업</h3>
  <button data-act="exportBackup">백업 파일 내보내기</button>
  <button data-act="pick" data-arg="fb">백업 파일 불러오기 (전체 교체)</button>
  <input type="file" id="fx" accept=".xlsx" data-change="importXlsx" hidden>
  <input type="file" id="fb" accept=".json,application/json" data-change="importBackup" hidden>
  <h3>예산</h3>
  <button data-act="go" data-arg="budgetSet">예산설정</button>
  <h3>반복 내역</h3>
  <ul class="list flush">${S.repeats.map(r => `<li><span class="c">${EVERY[r.every]}</span><span class="m"><b>${esc(r.tpl.note || r.tpl.cat)}</b><small>${esc(r.tpl.asset)} · 시작 ${r.start.slice(0, 10)}</small></span><span class="a ${cls(r.tpl.type)}">${won(r.tpl.amt)}</span><button data-act="delRepeat" data-arg="${r.id}">삭제</button></li>`).join('') || '<p class="empty">내역 입력의 "반복/할부"에서 추가합니다.</p>'}</ul>
  <h3>분류 · 자산 그룹 (한 줄에 하나)</h3>
  <form data-form="manage">
    <label>지출 분류<textarea name="expense" rows="6">${esc(S.cats.지출.join('\n'))}</textarea></label>
    <label>수입 분류<textarea name="income" rows="4">${esc(S.cats.수입.join('\n'))}</textarea></label>
    <label>자산 그룹<textarea name="groups" rows="5">${esc(S.groups.join('\n'))}</textarea></label>
    <button class="pri">저장</button>
  </form>
  <h3>초기화</h3>
  <button data-act="resetTx">가계부 내역만 초기화</button>
  <button data-act="resetAll">전체 초기화</button></div>`;

function exportXlsx() {
  const ws = XLSX.utils.aoa_to_sheet(Core.txToRows(S));
  for (let r = 1; r <= S.tx.length; r++) ws[XLSX.utils.encode_cell({ r, c: 0 })].z = 'yyyy-mm-dd hh:mm:ss';
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, '가계부 내역');
  XLSX.writeFile(wb, `my_moneybook_${today()}.xlsx`);
}

// ponytail: 사진은 내역 안에 줄인 이미지(data URL)로 넣어 백업 파일에 같이 담긴다. 사진이 수백 장을 넘어 백업이 무거워지면 별도 스토어로 분리
function exportBackup() {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([JSON.stringify(S)], { type: 'application/json' }));
  a.download = `my_moneybook_backup_${today()}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
}

async function importXlsx(file) {
  if (S.tx.length && !confirm(`지금 내역 ${S.tx.length}건을 지우고 파일 내용으로 바꿉니다. 계속할까요?`)) return;
  try {
    const wb = XLSX.read(await file.arrayBuffer());
    const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, raw: true });
    if (rows[0]?.[6] !== '수입/지출') throw new Error('편한가계부 엑셀 형식이 아닙니다.');
    Core.importRows(S, rows);
    done();
    alert(`${S.tx.length}건을 가져왔습니다.`);
  } catch (e) { alert('가져오기 실패: ' + e.message); }
}

async function importBackup(file) {
  try {
    const obj = JSON.parse(await file.text());
    if (obj.v !== 1 || !Array.isArray(obj.tx) || !Array.isArray(obj.assets)) throw new Error('백업 파일 형식이 아닙니다.');
    if (S.tx.length && !confirm(`지금 내역 ${S.tx.length}건을 지우고 백업(${obj.tx.length}건)으로 바꿉니다. 계속할까요?`)) return;
    S = { ...Core.newState(), ...obj };
    done();
  } catch (e) { alert('불러오기 실패: ' + e.message); }
}

// ---------- 공통 ----------
const PAGES = { tx: pageTx, favs: pageFavs, list: pageList, filter: pageFilter, budgetSet: pageBudgetSet, asset: pageAsset, assetInfo: pageAssetInfo, trend: pageTrend };
function render() {
  const pg = topPg();
  $('#main').innerHTML = pg ? PAGES[pg.p](pg) : { book: viewBook, stats: viewStats, assets: viewAssets, more: viewMore }[V.tab]();
  for (const b of $('#nav').children) b.classList.toggle('on', b.dataset.arg === V.tab);
}
function done() { save(); if (V.stack.length) history.back(); else render(); }
const lines = s => [...new Set(s.split('\n').map(x => x.trim()).filter(Boolean))];
const txById = id => S.tx.find(t => t.id === Number(id));

const ACT = {
  tab: a => { V.tab = a; V.stack.length = 0; render(); },
  sub: a => { V.sub = a; render(); },
  back: () => history.back(),
  go: p => go({ p, ...(p === 'filter' && { tab: '자산' }) }),
  month: a => { V.ym = Core.shiftYm(V.ym, Number(a) * (!topPg() && V.sub === 'month' ? 12 : 1)); V.q = ''; render(); },
  openMonth: ym => { V.openMonth = V.openMonth === ym ? '' : ym; render(); },
  range: a => { const [from, to] = a.split(','); go({ p: 'list', title: `${md(from)} ~ ${md(to)}`, from, to }); },
  dayList: d => go({ p: 'list', title: `${Number(d.slice(5, 7))}월 ${Number(d.slice(8))}일 ${DAYS[Core.dow(d)]}요일`, from: d, to: d }),
  ptab: a => { topPg().tab = a; render(); },
  pmonth: a => { const pg = topPg(); pg.ym = Core.shiftYm(pg.ym, Number(a) * (pg.tab === 'month' ? 12 : 1)); render(); },
  fClear: () => { for (const s of Object.values(V.filter)) s.clear(); render(); },
  stat: a => { V.statType = a; render(); },
  sNav: a => { const n = Number(a); V.sDay = V.sMode === 'week' ? Core.dAdd(V.sDay, 7 * n) : Core.shiftYm(V.sDay.slice(0, 7), V.sMode === 'year' ? 12 * n : n) + '-01'; render(); },
  statCat: c => { const [from, to] = statPeriod(); go({ p: 'list', title: c, from, to, cat: c, type: V.statType }); },
  newTx: d => { const pg = topPg(); openTx({ ...(d && { ts: d + nowTs().slice(10) }), ...(pg?.p === 'asset' && { asset: pg.name }) }); },
  editTx: id => go({ p: 'tx', t: { ...txById(id) } }),
  copyTx: id => { topPg().t = { ...txById(id), id: undefined, ts: nowTs() }; render(); },
  delTx: id => { if (confirm('이 내역을 삭제할까요?')) { S.tx = S.tx.filter(t => t.id !== Number(id)); done(); } },
  favTx: id => { const { id: _, ts, photo, ...f } = txById(id); S.favs.push(f); save(); alert('자주 사용하는 내역에 추가했습니다.'); },
  rmPhoto: () => { topPg().t = { ...formVals($('form')), photo: '' }; render(); },
  useFav: i => openTx({ ...S.favs[i], ts: nowTs() }),
  delFav: i => { S.favs.splice(i, 1); save(); render(); },
  delMemo: id => { S.memos = S.memos.filter(m => m.id !== Number(id)); save(); render(); },
  delRepeat: id => { if (confirm('이 반복을 멈출까요? 이미 만들어진 내역은 남습니다.')) { S.repeats = S.repeats.filter(r => r.id !== Number(id)); save(); render(); } },
  asset: name => go({ p: 'asset', name, tab: 'day', ym: today().slice(0, 7) }),
  assetInfo: () => go({ p: 'assetInfo', name: topPg().name }),
  newAsset: () => go({ p: 'assetInfo', name: '' }),
  trendOf: () => go({ p: 'trend', name: topPg().name }),
  memoTog: name => { V.openMemo.has(name) ? V.openMemo.delete(name) : V.openMemo.add(name); render(); },
  moveAsset: a => { const i = S.assets.findIndex(x => x.name === topPg().name), j = i + Number(a); if (S.assets[j]) { [S.assets[i], S.assets[j]] = [S.assets[j], S.assets[i]]; save(); alert('순서를 바꿨습니다.'); } },
  toggleDel: () => { const a = S.assets.find(x => x.name === topPg().name); a.deleted = !a.deleted; done(); },
  pay: () => { const name = topPg().name, c = Core.card(S, name, today().slice(0, 7)); openTx({ type: '이체', asset: liveNames().find(n => n !== name), cat: name, amt: c.due + c.unpaid || '', note: '카드 대금' }); },
  pick: id => $('#' + id).click(),
  resetTx: () => { if (confirm(`내역 ${S.tx.length}건과 반복 설정을 모두 지웁니다. 자산·분류는 남습니다. 계속할까요?`)) { S.tx = []; S.repeats = []; done(); } },
  resetAll: () => { if (confirm('내역·자산·분류·예산·메모를 전부 지웁니다. 되돌릴 수 없습니다. 계속할까요?')) { S = Core.newState(); done(); } },
  exportXlsx, exportBackup,
};
const FORM = {
  tx: saveTx,
  asset: saveAsset,
  memo: v => { S.memos.unshift({ id: S.seq++, text: v.text.trim() }); save(); render(); },
  budget: v => { S.budgets = {}; for (const [k, x] of Object.entries(v)) if (x !== '') S.budgets[k.slice(2)] = Math.round(Number(x)); done(); },
  manage: v => { S.cats.지출 = lines(v.expense); S.cats.수입 = lines(v.income); S.groups = lines(v.groups); save(); render(); alert('저장했습니다.'); },
};
const CHANGE = {
  search: el => { V.q = el.value.trim(); render(); },
  // 구분이나 분류를 바꾸면 입력하던 값을 들고 다시 그린다. 구분이 바뀌면 분류는 비운다
  txType: el => { const v = formVals(el.form); topPg().t = el.name === 'type' ? { ...v, cat: '', sub: '' } : v; render(); },
  photo: async el => { // 긴 변 1024px JPEG 로 줄여 붙인다
    if (!el.files[0]) return;
    const img = await createImageBitmap(el.files[0]), k = Math.min(1, 1024 / Math.max(img.width, img.height));
    const c = Object.assign(document.createElement('canvas'), { width: Math.round(img.width * k), height: Math.round(img.height * k) });
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
    topPg().t = { ...formVals(el.form), photo: c.toDataURL('image/jpeg', 0.7) };
    render();
  },
  fchk: el => { const s = V.filter[el.dataset.k]; if (el.checked) s.add(el.value); else s.delete(el.value); render(); },
  sMode: el => { V.sMode = el.value; render(); },
  sFrom: el => { V.sFrom = el.value || V.sFrom; render(); },
  sTo: el => { V.sTo = el.value || V.sTo; render(); },
  importXlsx: el => el.files[0] && importXlsx(el.files[0]),
  importBackup: el => el.files[0] && importBackup(el.files[0]),
};

document.addEventListener('click', e => {
  const el = e.target.closest('[data-act]');
  if (el) { e.stopPropagation(); ACT[el.dataset.act](el.dataset.arg); }
});
document.addEventListener('submit', e => {
  e.preventDefault();
  FORM[e.target.dataset.form](Object.fromEntries(new FormData(e.target, e.submitter)));
});
document.addEventListener('change', e => { const k = e.target.dataset.change; if (k) CHANGE[k](e.target); });
addEventListener('popstate', pop);

(async () => {
  S = { ...Core.newState(), ...(await idb('readonly', s => s.get('state'))) };
  if (Core.runRepeats(S, nowTs())) save(); // 앱을 안 연 사이에 돌아온 반복 내역을 채운다
  navigator.storage?.persist?.(); // 브라우저가 저장소를 임의로 비우지 않게 요청
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {}); // 파일로 직접 열면 등록이 안 되는데, 그때는 캐시 없이 쓴다
  render();
})();
