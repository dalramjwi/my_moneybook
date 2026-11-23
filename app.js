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
const fab = (arg = '') => `<button class="fab" data-act="newTx" data-arg="${arg}" aria-label="내역 추가">${ICON.plus}</button>`;

const monthNav = (act = 'month', label = ymLabel(V.ym)) => `<div class="month"><button data-act="${act}" data-arg="-1">‹</button><b>${label}</b><button data-act="${act}" data-arg="1">›</button></div>`;
const sumBox = (s, l = ['수입', '지출', '합계']) => `<div class="sum"><div>${l[0]}<b class="in">${num(s.income)}</b></div><div>${l[1]}<b class="out">${num(s.expense)}</b></div><div>${l[2]}<b>${num(s.income - s.expense)}</b></div></div>`;
// [가계부앱] 2026-11-23 : 금액 입력칸. 천 단위 쉼표를 찍어 보여 주고 뒤에 "원"을 붙인다 (입력 중에도 다시 찍음)
const toNum = s => Number(String(s ?? '').replace(/[^\d.-]/g, ''));
const comma = s => { const m = /^(-?)(\d*)/.exec(String(s ?? '').replace(/[^\d-]/g, '')); return m[2] ? m[1] + Number(m[2]).toLocaleString('ko-KR') : m[1]; };
const wonIn = s => { const c = comma(s); return c && c !== '-' ? c + '원' : c; }; // 입력칸 안에 "3,513원" 으로 보이게
const money = (name, v, ph = '') => `<input name="${name}" inputmode="numeric" autocomplete="off" data-money value="${wonIn(v)}" placeholder="${ph}">`;
// 커서는 항상 "원" 앞에 둔다 (지우기를 누르면 숫자가 지워지게)
const caret = el => { const u = el.dataset.unit || '원', p = el.value.length - (el.value.endsWith(u) ? u.length : 0); el.setSelectionRange(p, p); };
const liveNames = () => S.assets.filter(a => !a.deleted).map(a => a.name);
const isCard = a => a.group.includes('카드') && !/체크|선불/.test(a.group);

// ---------- 가계부 ----------
// o.name : 자산 상세에서 볼 때 그 자산 기준으로 색을 정한다(들어오면 파랑, 나가면 빨강). o.bal : 내역 id -> 누적잔액
function txRow(t, o = {}) {
  const tr = t.type === '이체';
  const c = tr && o.name ? (t.cat === o.name ? 'in' : 'out') : cls(t.type);
  return `<li data-act="editTx" data-arg="${t.id}"><span class="c">${esc(tr ? '이체' : t.cat)}</span>
    <span class="m">${tr && !t.note ? `<b class="sub">${esc(`${t.asset} → ${t.cat}`)}</b><small>${hm(t.ts)}</small>` : `<b>${esc(t.note)}</b><small>${hm(t.ts)} ${esc(tr ? `${t.asset} → ${t.cat}` : t.asset)}</small>`}</span>
    <span class="a ${c}">${won(t.amt)}${t.cur ? `<small>${esc(t.cur)} ${Number(t.famt).toLocaleString('ko-KR')}</small>` : ''}${o.bal ? `<small>(${num(o.bal.get(t.id))})</small>` : ''}</span></li>`;
}

const dayHead = (d, s, right = '') => { const w = Core.dow(d); return `<h3><b>${Number(d.slice(8))}</b><i class="wd w${w}">${DAYS[w]}요일</i><small>${d.slice(0, 4)}.${d.slice(5, 7)}</small><span class="in">${won(s.income)}</span><span class="out">${won(s.expense)}</span>${right}</h3>`; };
// 날짜별로 묶은 내역 목록. o.sum : 날짜 머리줄의 합계 계산 방법(기본은 수입·지출)
function dayList(list, o = {}) {
  const byDay = new Map();
  for (const t of list.slice(0, 500)) { const d = t.ts.slice(0, 10); byDay.set(d, [...(byDay.get(d) || []), t]); }
  let html = '';
  for (const [d, items] of byDay) {
    html += `${dayHead(d, (o.sum || Core.sums)(items))}<ul class="list">${items.map(t => txRow(t, o)).join('')}</ul>`;
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
    cells += `<button data-act="dayList" data-arg="${d}" class="w${Core.dow(d)}${d === today() ? ' today' : ''}"><b>${d === first ? Number(d.slice(5, 7)) + '.' : ''}${Number(d.slice(8))}</b>${o.수입 ? `<small class="in">${num(o.수입)}</small>` : ''}${o.지출 ? `<small class="out">${num(o.지출)}</small>` : ''}</button>`;
  }
  return `${sumBox(Core.sums(list))}<div class="cal">${DAYS.map((d, i) => `<em class="w${i}">${d}</em>`).join('')}${cells}</div>`;
}

// [가계부앱] 2026-11-23 : 달력에서 날짜를 누르면 뜨는 그날 창. 내역 목록과 메모 보기를 오가고, 아래 화살표로 앞뒤 날짜로 넘긴다
// 메모 색. 첫 번째(노랑)가 기본
const MEMO_COL = ['#fdeb96', '#ffd3cc', '#cfe6ff', '#d9f2c4', '#e6dcff', '#e9ecf0', '#ffffff'];
const memoCard = m => `<li data-act="editMemo" data-arg="${m.id}"${m.color ? ` style="background:${m.color}"` : ''}>${m.pin ? ICON.pin : ''}<div>${m.title ? `<b>${esc(m.title)}</b>` : ''}<pre>${esc(m.text)}</pre></div></li>`;
function pageDay(pg) {
  const d = pg.d, items = S.tx.filter(t => t.ts.startsWith(d)).sort(desc);
  const pins = S.memos.filter(m => m.pin), memos = [...pins, ...S.memos.filter(m => !m.pin && m.date === d)];
  const body = pg.memo ? `<ul class="memo">${memos.map(memoCard).join('') || '<p class="empty">메모가 없습니다.</p>'}</ul>`
    : `${pins.length ? `<p class="pinline" data-act="dayMemo"><i${pins[0].color ? ` style="background:${pins[0].color}"` : ''}></i>${esc(pins.map(m => m.text.replace(/\s+/g, ' ')).join('  '))}</p>` : ''}<ul class="list">${items.map(t => txRow(t)).join('')}</ul>${items.length ? '' : '<p class="empty">데이터가 없습니다.</p>'}`;
  return `${viewBook()}<div class="dim" data-act="back"></div><div class="sheet day">
    ${dayHead(d, Core.sums(items), `<button class="ic${pg.memo ? ' on' : ''}" data-act="dayMemo" aria-label="메모 보기">${ICON.memo}</button>`)}
    <div class="dbody">${body}</div>
    <button class="fab two" data-act="newMemo" data-arg="${d}" aria-label="메모 추가">${ICON.memoAdd}</button>${fab(d)}
    <footer><button class="ic" data-act="dayNav" data-arg="-1" aria-label="전날">‹</button><button class="ic" data-act="dayNav" data-arg="1" aria-label="다음 날">›</button><span class="grow"></span><button class="ic" data-act="back">닫기</button></footer></div>`;
}

// 메모 쓰기·고치기. 고정한 메모는 달력의 모든 날짜 창에 보인다
// ponytail: 원본의 메모 색 고르기는 뺐다. 색 구분이 필요해지면 메모에 color 를 두고 카드 배경에 쓴다
function pageMemo(pg) { // 날짜 창은 내역 입력 화면의 것을 같이 쓴다 (pg.t.ts 에 날짜를 둠)
  const m = pg.t, d = m.ts.slice(0, 10);
  return `${head('메모', `<button class="ic" data-act="memoPal" aria-label="메모 색">${ICON.palette}</button><button class="ic${m.pin ? ' on' : ''}" data-act="memoPin" aria-label="고정">${ICON.pin}</button>`)}
    ${pg.pal ? `<div class="pal">${MEMO_COL.map(c => `<button type="button" data-act="memoCol" data-arg="${c}" style="background:${c}"${(m.color || MEMO_COL[0]) === c ? ' class="on"' : ''} aria-label="색 ${c}"></button>`).join('')}</div>` : ''}
    <form data-form="memo" class="mform"${m.color ? ` style="background:${m.color};color:#1d1f23"` : ''}><input type="hidden" name="id" value="${m.id || ''}">
    <button type="button" class="mdate" data-act="sheet" data-arg="date">${Number(d.slice(5, 7))}.${Number(d.slice(8))} (${DAYS[Core.dow(d)]})</button>
    <input name="title" class="mtitle" placeholder="제목" value="${esc(m.title || '')}" autocomplete="off">
    <textarea name="text" placeholder="메모" rows="12" required>${esc(m.text || '')}</textarea>
    <div class="row"><button class="pri">저장하기</button>${m.id ? `<button type="button" data-act="delMemo" data-arg="${m.id}">삭제</button>` : ''}</div>${sheet(pg)}</form>`;
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
// [가계부앱] 2026-11-23 : 루틴 알림. 오늘 돌아온 것과 밀린 것을 가계부 탭 맨 위에 체크 목록으로 보여 준다. 체크하면 다음 회차까지 사라진다
// [가계부앱] 2026-11-23 : 자산에 적어 둔 날짜에서 저절로 생기는 알림. 카드 결제일·연회비, 저축 납입일, 대출 상환일, 보험 납입일
// 체크한 회차는 자산의 rtDone 에, 알림을 시작한 날은 rtSince 에 둔다 (자산을 저장할 때 정해짐)
function assetRoutines() {
  const out = [];
  for (const a of S.assets) {
    if (a.deleted) continue;
    const g = a.group, add = (key, text, r) => out.push({ id: `${key}:${a.name}`, text, since: a.rtSince || today(), done: a.rtDone?.[key], ...r });
    if (isCard(a)) {
      if (a.payDay) add('p', `${a.name} 결제일`, { every: 'month', day: a.payDay });
      if (a.annualFee && a.annualMonth) add('f', `${a.name} 연회비 ${won(a.annualFee)}`, { every: 'year', month: a.annualMonth });
    } else if (/저축|대출|마이너스|보험/.test(g) && a.dueDay) add('d', `${a.name} ${g === '저축' ? '납입' : g === '보험' ? '보험료' : '상환'}${a.monthly ? ' ' + won(a.monthly) : ''}`, { every: 'month', day: a.dueDay, until: a.endDate });
  }
  return out;
}
function todoBox() {
  const t = today(), due = [...(S.routines || []), ...assetRoutines()].map(r => [r, Core.routineDue(r, t)]).filter(x => x[1]).sort((a, b) => a[1].localeCompare(b[1]));
  return due.length ? `<ul class="todo">${due.map(([r, d]) => `<li data-act="rtDone" data-arg="${r.id}"><i></i><span class="m">${esc(r.text)}</span><small${d < t ? ' class="late"' : ''}>${d < t ? `밀림 ${md(d)}` : '오늘'}</small></li>`).join('')}</ul>` : '';
}
const rtRule = r => (r.every === 'week' ? `매주 ${DAYS[r.dow]}요일` : r.every === 'once' ? r.date : `매월 ${r.day}일`);
function pageRoutines() {
  const all = S.routines || [], row = r => `<li data-act="rtEdit" data-arg="${r.id}"${r.every === 'once' && r.done ? ' class="off"' : ''}><span class="c">${rtRule(r)}</span><span class="m"><b>${esc(r.text)}</b></span><span class="pen">${r.every === 'once' && r.done ? '✓' : ICON.pen}</span></li>`;
  const sec = (title, items) => `<h3 class="gh">${title}</h3><ul class="list wrap">${items.map(row).join('') || '<p class="empty">없음</p>'}</ul>`;
  return `${head('루틴 · 할 일', '<button class="ic" data-act="rtEdit" data-arg="" aria-label="추가">＋</button>')}<p class="cap pad">날짜가 되면 가계부 탭 맨 위에 뜹니다. 반복은 체크하면 다음 회차까지 사라지고, 할 일은 체크하면 끝납니다. 앱을 닫아 둔 동안 폰 알림으로 뜨지는 않습니다.</p>
    ${sec('반복 (루틴)', all.filter(r => r.every !== 'once'))}${sec('할 일 (한 번)', all.filter(r => r.every === 'once').sort((x, y) => x.date.localeCompare(y.date)))}`;
}
function pageRoutine(pg) {
  const r = pg.r, opt = (v, l, cur) => `<option value="${v}"${String(cur) === String(v) ? ' selected' : ''}>${l}</option>`;
  const when = r.every === 'week' ? `<label class="frow"><span>요일</span><select name="dow">${DAYS.map((d, i) => opt(i, d + '요일', r.dow ?? 1)).join('')}</select></label>`
    : r.every === 'once' ? `<label class="frow"><span>날짜</span><input type="date" name="date" value="${r.date || today()}" required></label>`
    : `<label class="frow"><span>일</span><input inputmode="numeric" autocomplete="off" data-unit="일" name="day" value="${r.day || ''}일" required></label>`;
  return `${head(r.id ? '루틴 · 할 일 수정' : '루틴 · 할 일 추가')}<form data-form="routine" class="form"><input type="hidden" name="id" value="${r.id || ''}">
    <label class="frow"><span>내용</span><textarea name="text" rows="${Math.max(2, Math.ceil((r.text || '').length / 16))}" placeholder="예: 카드 결제 대금 확인" required>${esc(r.text || '')}</textarea></label>
    <label class="frow"><span>주기</span><select name="every" data-change="rtEvery">${opt('month', '매월', r.every)}${opt('week', '매주', r.every)}${opt('once', '할 일 (한 번)', r.every)}</select></label>
    ${when}
    <div class="row"><button class="pri">저장하기</button>${r.id ? `<button type="button" data-act="rtDel" data-arg="${r.id}">삭제</button>` : ''}</div></form>`;
}

function viewBudget() {
  const rows = Core.budgetRows(S, V.ym).filter(r => r.cat === '전체' || r.budget), t = today(); // [가계부앱] 2026-11-23 : 예산 0원 분류는 결산에서 숨김 (원본과 같게)
  const pos = t.startsWith(V.ym) ? Number(t.slice(8)) / Number(Core.monthEnd(V.ym).slice(8)) * 100 : null;
  const bar = r => { // [가계부앱] 2026-11-23 : 이월 분류는 그 달 예산과 이월을 나눠 표시. 막대·남은 돈은 둘을 합한 금액 기준
    const p = r.budget ? Math.floor(r.spent / r.budget * 100) : 0, over = r.spent > r.budget;
    return `<li class="bud" data-act="budView" data-arg="${esc(r.cat)}"><div class="bl"><small>${esc(r.cat === '전체' ? '전체예산' : r.cat)}</small><b>${won(r.budget - (r.carry || 0))}</b>${r.roll || r.carry ? `<small class="carry${r.carry < 0 ? ' neg' : ''}">${r.cat === '전체' ? '이월 합' : '이월'} ${r.carry > 0 ? '+' : ''}${won(r.carry || 0)}</small>` : ''}</div>
      <div class="br">${pos != null && r.cat === '전체' ? `<em class="tod" style="left:${pos}%">오늘</em>` : ''}<div class="bar${over ? ' over' : ''}${p >= 85 ? ' full' : ''}"><i style="width:${Math.min(p, 100)}%"></i>${pos == null ? '' : `<u style="left:${pos}%"></u>`}<span>${r.budget ? p + '%' : '-'}</span></div>
      <div class="bv"><span class="${over ? 'out' : 'in'}">${won(r.spent)}</span><span>${over ? '초과 ' : ''}${won(r.budget - r.spent)}</span></div></div></li>`;
  };
  return `${sumBox(Core.periodSums(S.tx, V.ym))}<h3 class="plain bh">${ICON.budget}<b>예산</b><span><button data-act="go" data-arg="budgetSet">예산설정 ›</button></span></h3>
    ${rows.length > 1 || rows[0].budget ? `<ul class="list">${rows.map(bar).join('')}</ul>` : '<p class="empty">예산설정에서 분류별 예산을 넣으면 여기에 표시됩니다.</p>'}`;
}

const viewMemo = () => `<ul class="memo top">${S.memos.map(m => memoCard(m).replace('<div>', `<div>${m.date ? `<small>${md(m.date)}</small>` : ''}`)).join('') || '<p class="empty">메모가 없습니다.</p>'}</ul>
  <button class="fab two" data-act="newMemo" data-arg="" aria-label="메모 추가">${ICON.memoAdd}</button>`;

function viewBook() {
  const tabs = [['day', '일일'], ['cal', '달력'], ['month', '월별'], ['budget', '결산'], ['memo', '메모']].map(([k, n]) => `<button data-act="sub" data-arg="${k}"${V.sub === k ? ' class="on"' : ''}>${n}</button>`).join('');
  return `<header>${monthNav('month', V.sub === 'month' ? V.ym.slice(0, 4) + '년' : ymLabel(V.ym))}<span class="hic"><button class="ic" data-act="go" data-arg="favs" aria-label="자주 사용">${ICON.favs}</button><button class="ic${fActive() ? ' on' : ''}" data-act="go" data-arg="filter" aria-label="필터">${ICON.filter}</button></span></header>
    ${todoBox()}<div class="tabs">${tabs}</div>${{ day: viewDay, cal: viewCal, month: viewMonth, budget: viewBudget, memo: viewMemo }[V.sub]()}${V.sub === 'memo' ? '' : fab()}`;
}

// [가계부앱] 2026-11-23 : 한 분류의 내역을 소분류별 합계로 (소분류가 둘 이상일 때만)
function subBreak(list) {
  if (S.subOff) return '';
  const m = {};
  for (const t of list) m[t.sub || '소분류 없음'] = (m[t.sub || '소분류 없음'] || 0) + t.amt;
  const subs = Object.entries(m).sort((a, b) => b[1] - a[1]), total = subs.reduce((s, r) => s + r[1], 0);
  return subs.length > 1 ? `<ul class="list">${subs.map(([k, v], i) => `<li><span class="pct" style="background:${PAL[i % PAL.length]}">${Math.round(v / total * 100)}%</span><span class="m"><b>${esc(k)}</b></span><span class="a">${won(v)}</span></li>`).join('')}</ul>` : '';
}
function pageList(pg) {
  const list = Core.between(S.tx, pg.from, pg.to).filter(t => !pg.cat || (t.type === pg.type && t.cat === pg.cat)).sort(desc);
  const subList = pg.cat ? subBreak(list) : '';
  return head(pg.title) + sumBox(Core.sums(list)) + subList + dayList(list) + fab(pg.from === pg.to ? pg.from : '');
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

// [가계부앱] 2026-11-23 : 예산 화면을 원본 흐름대로. 예산 목록 -> (연필) 분류별 기본예산·월별 예산, 결산의 줄 -> 분류별 예산 상세(월별 막대 + 예산 선 + 그 달 내역)
const budLabel = c => (c === '전체' ? '전체예산' : c);
const budInfo = html => `<p class="binfo"><i>${ICON.budget}</i><span>${html}</span></p>`;
function pageBudgetSet() {
  const row = c => `<li data-act="budEdit" data-arg="${esc(c)}"><span class="m"><b>${esc(budLabel(c))}</b></span><span class="a">${won(S.budgets[c])}</span><span class="pen">${ICON.pen}</span></li>`;
  return `${head('예산', '<button class="ic" data-act="go" data-arg="budAdd" aria-label="예산 추가">＋</button>')}${budInfo('추가된 예산은 <b>가계부탭 - 결산</b>에서 확인하실 수 있습니다.')}
    <ul class="list">${Core.budCats(S).map(row).join('')}</ul>`;
}
function pageBudAdd() {
  const rest = S.cats.지출.filter(c => S.budgets[c] == null);
  return `${head('예산추가')}<form data-form="budAdd" class="form">
    <label class="frow"><span>분류</span><select name="cat" required>${rest.map(c => `<option>${esc(c)}</option>`).join('')}</select></label>
    <label class="frow"><span>금액</span>${money('amt', '')}</label>
    <div class="row"><button class="pri"${rest.length ? '' : ' disabled'}>저장하기</button></div></form>`;
}
function pageBudCat(pg) {
  const c = pg.cat, cur = today().slice(0, 7), base = S.budgets[c];
  const months = [...Array(12)].map((_, i) => `${pg.y}-${String(12 - i).padStart(2, '0')}`);
  return `${head(budLabel(c), `<div class="month"><button data-act="byear" data-arg="-1">‹</button><b>${pg.y}년</b><button data-act="byear" data-arg="1">›</button></div><button class="ic" data-act="budDel" aria-label="예산 삭제">${ICON.del}</button>`)}
    ${budInfo('기본 예산을 변경하면, 기본 예산은 다음달부터 적용됩니다. 월을 선택하면, 월별 예산을 설정할 수 있습니다.')}
    <ul class="list bm"><li data-act="budRoll"><span class="m"><b class="big">이월</b><small>남은 돈·초과를 다음 달로 넘김</small></span><span class="a"><b>${S.budRoll?.[c] ? `${ymLabel(S.budRoll[c])}부터 · ${won(Core.carryOf(S, c, Core.shiftYm(cur, 1)))}` : '끔'}</b></span></li><li data-act="budBase"><span class="m"><b class="big">기본예산</b></span><span class="a"><b>${won(base)}</b></span></li>
    ${months.map(ym => { const own = S.budgetM?.[c]?.[ym]; return `<li data-act="budMonth" data-arg="${ym}"><span class="m"><i class="mo${ym === cur ? ' on' : ''}">${Number(ym.slice(5))}월</i></span><span class="a">${won(Core.budgetOf(S, c, ym) ?? 0)}</span></li>`; }).join('')}</ul>`;
}
function pageBudView(pg) {
  const c = pg.cat, y = pg.ym.slice(0, 4), mine = t => t.type === '지출' && (c === '전체' || t.cat === c);
  const yms = [...Array(12)].map((_, i) => `${y}-${String(i + 1).padStart(2, '0')}`);
  const spent = yms.map(ym => S.tx.reduce((s, t) => s + (t.ts.startsWith(ym) && mine(t) ? t.amt : 0), 0));
  const buds = yms.map(ym => Core.budgetRows(S, ym).find(r => r.cat === c)?.budget ?? 0);
  const i0 = Number(pg.ym.slice(5)) - 1, list = S.tx.filter(t => t.ts.startsWith(pg.ym) && mine(t)).sort(desc);
  // 눈금 : 최댓값의 1.1배를 셋으로 나눠 보기 좋은 단위(1·2·2.5·5)로 올림
  const raw = Math.max(...spent, ...buds, 1) * 1.1 / 3, pw = 10 ** Math.floor(Math.log10(raw)), step = [1, 2, 2.5, 5, 10].find(k => k * pw >= raw) * pw;
  const W = 412, H = 200, L = 50, T = 18, B = 34, x = i => L + 16 + i * (W - L - 30) / 11, yy = v => T + (H - T - B) * (1 - v / (step * 3));
  const k = v => (v >= 1000 ? v / 1000 + 'k' : String(v));
  return `${head(budLabel(c), `${monthNav('pmonth', ymLabel(pg.ym))}${c === '전체' ? '' : `<button class="ic" data-act="budEdit" data-arg="${esc(c)}" aria-label="예산 수정">${ICON.pen}</button>`}`)}
    <div class="sum"><div>예산<b>${won(buds[i0])}</b></div><div>사용금액<b class="out">${won(spent[i0])}</b></div><div>남은금액<b>${won(buds[i0] - spent[i0])}</b></div></div>
    <svg class="chart bchart" viewBox="0 0 ${W} ${H}" role="img" aria-label="월별 사용금액과 예산">
      ${[0, 1, 2, 3].map(n => `<line x1="${L}" x2="${W}" y1="${yy(step * n)}" y2="${yy(step * n)}"/><text x="${L - 8}" y="${yy(step * n) + 4}" text-anchor="end">${k(step * n)}</text>`).join('')}<line x1="${L}" x2="${L}" y1="0" y2="${yy(0)}"/>
      ${spent.map((v, i) => `<rect x="${x(i) - 6}" width="12" y="${yy(v)}" height="${yy(0) - yy(v)}"/><text x="${x(i)}" y="${H - 12}" text-anchor="middle">${i + 1}월</text>`).join('')}
      <polyline points="${buds.map((v, i) => `${x(i)},${yy(v)}`).join(' ')}"/>${buds.map((v, i) => `<circle cx="${x(i)}" cy="${yy(v)}" r="4"${i === i0 ? ' class="now"' : ''}/>`).join('')}</svg>
    ${dayList(list)}`;
}

// ---------- 내역 입력 ----------
function openTx(init) {
  if (!liveNames().length) return alert('자산 탭에서 자산을 먼저 추가하세요.');
  go({ p: 'tx', t: { type: '지출', ts: nowTs(), ...init } });
}

// [가계부앱] 2026-11-23 : 날짜·시간·분류·자산은 선택 상자 대신 아래에서 올라오는 선택판(검은 머리줄 + 칸)으로 고른다. 고르면 다음 항목으로 넘어간다
const dateLabel = ts => { const d = ts.slice(0, 10); return `${d.slice(2, 4)}. ${Number(d.slice(5, 7))}. ${Number(d.slice(8))}. (${DAYS[Core.dow(d)]})`; };

// 그 분류의 소분류 목록. 분류 관리 화면에서 정해 둔 목록이 있으면 그것을, 없으면 지금까지 내역에 쓴 소분류를 모아서 쓴다
const subsOf = (type, cat) => S.subOff ? [] : S.subs[cat] ?? [...new Set(S.tx.filter(x => x.type === type && x.cat === cat && x.sub).map(x => x.sub))];

function sheet(pg) {
  const t = pg.t, k = pg.pick, tr = t.type === '이체';
  if (!k) return '';
  const cell = (v, label = v, on = false) => `<button type="button" data-act="choose" data-arg="${esc(v)}"${on ? ' class="on"' : ''}>${esc(label)}</button>`;
  let title, body;
  if (k === 'date' || k === 'time') { // 가운데 뜨는 창. pg.tmp 에 고르는 중인 값을 두고 확인을 누르면 반영
    // [가계부앱] 2026-11-23 : 날짜는 누르면 바로 반영하고 닫으므로 확인/취소 줄 없음 (바깥을 누르면 닫힘). 시간만 확인
    const d = pg.tmp.slice(0, 10), foot = k === 'date' ? '' : '<div class="df"><button type="button" data-act="sheet" data-arg="">취소</button><button type="button" data-act="pickOk">확인</button></div>';
    let inner;
    if (k === 'date') {
      const ym = pg.calYm ||= d.slice(0, 7), first = ym + '-01', td = today();
      let cells = DAYS.map(x => `<em>${x}</em>`).join('') + '<i></i>'.repeat(Core.dow(first));
      for (let x = first; x <= Core.monthEnd(ym); x = Core.dAdd(x, 1)) cells += `<button type="button" data-act="choose" data-arg="${x}" class="${x === d ? 'on' : x === td ? 'today' : ''}">${Number(x.slice(8))}</button>`;
      inner = `<div class="dh"><small>${d.slice(0, 4)}년</small><b>${Number(d.slice(5, 7))}월 ${Number(d.slice(8))}일 (${DAYS[Core.dow(d)]})</b></div>
        ${monthNav('calNav', ymLabel(ym))}<div class="cal2">${cells}</div>`;
    } else {
      const h = Number(pg.tmp.slice(11, 13));
      inner = `<div class="dh"><small>${Number(d.slice(5, 7))}월 ${Number(d.slice(8))}일 (${DAYS[Core.dow(d)]})</small><b class="tmv">${hm(pg.tmp)}</b></div>
        <div class="quick time">${cell('ap:오전', '오전', h < 12)}${cell('ap:오후', '오후', h >= 12)}<input inputmode="numeric" maxlength="2" data-tm="h" value="${h % 12 || 12}" aria-label="시"><b>:</b><input inputmode="numeric" maxlength="2" data-tm="m" value="${pg.tmp.slice(14, 16)}" aria-label="분">${cell('now', '지금')}</div>`;
    }
    return `<div class="modal" data-act="sheet" data-arg=""><div class="dlg" data-act="nop">${inner}${foot}</div></div>`;
  }
  if (k === 'repMenu') return '<div class="modal clear" data-act="sheet" data-arg=""><div class="menu" data-act="nop"><button type="button" data-act="repGo" data-arg="repeat">반복</button><button type="button" data-act="repGo" data-arg="inst">할부</button></div></div>';
  if (k === 'cat' && !tr) { // 분류 격자. 소분류가 있는 분류(회색 칸)를 누르면 그 분류의 소분류 격자로 바뀐다
    const cur = pg.pcat, edit = '<span class="grow"></span><button type="button" class="ic" data-act="sheetEdit" aria-label="분류 관리">✎</button>';
    title = (cur ? `<button type="button" class="ic" data-act="pcat" data-arg="" aria-label="분류 목록으로">‹</button><b>${esc(cur)}</b>` : '<b>분류</b>') + edit;
    body = cur ? `<div class="grid">${cell('', '소분류 없음', cur === t.cat && !t.sub)}${subsOf(t.type, cur).map(x => cell(x, x, cur === t.cat && x === t.sub)).join('')}</div>`
      : `<div class="grid">${(S.cats[t.type] || []).map(c => `<button type="button" data-act="pcat" data-arg="${esc(c)}" class="${c === t.cat ? 'on' : ''}${subsOf(t.type, c).length ? ' has' : ''}">${esc(c)}</button>`).join('')}</div>`;
  } else {
    title = `<b>${k === 'cat' ? '입금' : tr ? '출금' : '자산'}</b><span class="grow"></span><button type="button" class="ic" data-act="sheetEdit" aria-label="자산 설정">✎</button>`;
    body = `<div class="grid">${liveNames().map(v => cell(v, v, v === t[k])).join('')}</div>`;
  }
  return `<div class="sheet"><div class="sh">${title}<button type="button" class="ic" data-act="sheet" data-arg="" aria-label="닫기">✕</button></div>${body}</div>`;
}

// 버튼 아이콘 (선으로 그린 휴지통·복사·별)
const svg = d => `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
const ICON = {
  del: svg('<path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/>'),
  copy: svg('<rect x="8" y="8" width="11" height="12" rx="2"/><path d="M5 16V6a2 2 0 0 1 2-2h8"/>'),
  star: svg('<path d="M12 3.5l2.6 5.4 5.9.8-4.3 4.1 1 5.8-5.2-2.8-5.2 2.8 1-5.8-4.3-4.1 5.9-.8z"/>'),
  filter: svg('<path d="M3 7h18M3 12h18M3 17h18"/><g fill="var(--card)"><rect x="9" y="4.7" width="2.4" height="4.6" rx=".8"/><rect x="14.6" y="9.7" width="2.4" height="4.6" rx=".8"/><rect x="6.7" y="14.7" width="2.4" height="4.6" rx=".8"/></g>'),
  favs: svg('<path d="M11.5 16.5l-5 3 1.2-6.2L3 9.2l6.2-.7L12 3l2.800 5.5 6.2.7-2.5 2.300"/><path stroke-width=".9" d="M12.5 13.8h8M12.5 16.2h8M12.5 18.6h8M12.5 21h8"/>'),
  memo: svg('<rect x="4.5" y="3" width="15" height="18" rx="1.5"/><path d="M11.5 8h4.5M11.5 12h4.5M11.5 16h4.5"/><rect x="7.5" y="7.2" width="1.6" height="1.6"/><rect x="7.5" y="11.2" width="1.6" height="1.6"/><rect x="7.5" y="15.2" width="1.6" height="1.6"/>'),
  memoAdd: svg('<path d="M19.5 12V4.5A1.5 1.5 0 0 0 18 3H6a1.5 1.5 0 0 0-1.5 1.5v15A1.5 1.5 0 0 0 6 21h6.5M11.5 8H16M11.5 12H16M16 18.5h5M18.5 16v5"/><rect x="7.5" y="7.2" width="1.6" height="1.6"/><rect x="7.5" y="11.2" width="1.6" height="1.6"/><rect x="7.5" y="15.2" width="1.6" height="1.6"/>'),
  pin: svg('<path d="M8 3h8l-1 2v5l3 3.5H6L9 10V5zM12 13.500V21"/>'.replace('.500', '.5')),
  budget: svg('<path d="M3 9.5h18V20H3zM5.500 9.500L12.500 4l8 5.500M9 6.800l3.800 2.700M11 5.200l6 4.300M6.500 16.500h7"/>'.replace(/00/g, '')),
  pen: svg('<path d="M4 20l1-4.500L16.500 4l3.500 3.500L8.500 19zM14.500 6l3.500 3.500"/>'.replace(/00/g, '')),
  palette: svg('<path d="M12 3a9 9 0 0 0 0 18c1.1 0 1.8-.8 1.8-1.800 0-.5-.2-.9-.5-1.200a1.700 1.700 0 0 1 1.300-2.800H17a4 4 0 0 0 4-4C21 6.500 17 3 12 3z"/><circle cx="7.500" cy="11.500" r=".9"/><circle cx="10" cy="7.500" r=".9"/><circle cx="14.500" cy="7.500" r=".9"/>'.replace(/00/g, '')),
  bars: svg('<path d="M3.5 5v14h17M7.5 16v-4M10.5 16V9M13.5 16v-5M16.5 16V8"/>'),
  rows: svg('<path d="M9 6h11M9 12h11M9 18h11"/><path stroke-width="2.6" d="M4 6h.5M4 12h.5M4 18h.5"/>'),
  dots: svg('<g fill="currentColor" stroke="none"><circle cx="12" cy="5.5" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="12" cy="18.5" r="1.6"/></g>'),
  eye: svg('<path d="M2.5 12S6 6 12 6s9.5 6 9.5 6-3.5 6-9.5 6-9.5-6-9.5-6z"/><circle cx="12" cy="12" r="3"/>'),
  eyeOff: svg('<path d="M2.5 12S6 6 12 6s9.5 6 9.5 6-3.5 6-9.5 6-9.5-6-9.5-6z"/><circle cx="12" cy="12" r="3"/><path d="M4 4l16 16"/>'),
  coins: svg('<ellipse cx="15" cy="6.5" rx="5.5" ry="2.5"/><path d="M9.5 6.5V9M20.5 6.5v7c0 1-1.3 1.9-3.3 2.3M20.5 10c0 1-1.3 1.9-3.3 2.3"/><ellipse cx="9.5" cy="12.5" rx="5.5" ry="2.5"/><path d="M4 12.5v6c0 1.4 2.5 2.5 5.5 2.5s5.5-1.1 5.5-2.5v-6M4 15.5C4 16.9 6.5 18 9.500 18s5.500-1.100 5.500-2.500"/>'.replace(/00/g, '')),
  chat: svg('<path d="M4 5h16v11H9.5L5 19.5V16H4z"/><path d="M8 9.300h8M8 12.300h5"/>'.replace(/00/g, '')),
  gear: svg('<g transform="translate(1.4 1.4) scale(.883)"><circle cx="12" cy="12" r="3.2"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/></g>'),
  undo: svg('<path d="M3.6 4.2l1.1 5.4 5.3-1.3zM5.3 8.6A8.2 8.2 0 1 1 7.3 18.9"/>'),
  todo: svg('<rect x="4" y="4" width="16" height="16" rx="3"/><path d="M8 12.5l3 3 5-6"/>'),
  plus: svg('<path d="M12 5v14M5 12h14"/>'),
  minus: svg('<path d="M5 12h14"/>'),
  rep: svg('<path d="M17 3l3 3-3 3M20 6H8a4 4 0 0 0-4 4v1M7 21l-3-3 3-3M4 18h12a4 4 0 0 0 4-4v-1"/>'),
};
const repLabel = t => (t.rep === 'inst' ? `할부 ${t.months}개월${Number(t.irate) > 0 ? `<br>연 ${Number(t.irate)}%` : ''}` : EVERY[t.rep] || '반복/할부'); // 버튼 안에 그대로 넣는다. 이자가 있으면 두 줄

// [가계부앱] 2026-11-23 : 글 입력칸을 input·textarea 가 아닌 편집 가능한 div 로 그린다. 크롬이 자판 위에 띄우는 자동 완성 줄(열쇠·카드·주소)은 폼 입력칸에만 붙기 때문
// 값은 옆의 숨은 input 에 그때그때 옮겨 두어 저장·다시 그리기는 다른 칸과 똑같이 동작한다
const ce = (name, v, one) => `<div class="ce${one ? ' one' : ''}" contenteditable="plaintext-only" role="textbox" aria-label="${name === 'note' ? '내용' : '메모'}" enterkeyhint="${one ? 'done' : 'enter'}" data-ce="${name}"${one ? ' data-sug' : ''}>${esc(v || '')}</div><input type="hidden" name="${name}" value="${esc(v || '')}">`;
const ceVal = el => (el.dataset.ce ? el.innerText.replace(/\u00a0/g, ' ') : el.value);

function pageTx(pg) {
  const t = pg.t = { asset: '', cat: '', sub: '', note: '', amt: '', tag: '', memo: '', ...pg.t }, tr = t.type === '이체', names = liveNames();
  if (t.ts.length === 16) t.ts += ':00';
  t.asset ||= names[0];
  if (tr && !t.cat) t.cat = names.find(n => n !== t.asset) || ''; // 입금 기본값이 출금과 같지 않게
  const fa = S.assets.find(a => a.name === t.asset);
  const row = (label, inner) => `<label class="frow"><span>${label}</span>${inner}</label>`;
  const fld = (k, text) => `<button type="button" class="fld${pg.pick === k ? ' on' : ''}" data-act="sheet" data-arg="${k}">${esc(text) || '&nbsp;'}</button>`;
  const prow = (label, k, text) => `<div class="frow"><span>${label}</span>${fld(k, text)}</div>`;
  return `${head(t.type)}<form data-form="tx" class="form t-${cls(t.type)}${pg.pick ? ' picking' : ''}${t.id ? ' edit' : ''}${pg.dirty ? ' dirty' : ''}">
    <input type="hidden" name="id" value="${t.id ?? ''}"><input type="hidden" name="sub" value="${esc(t.sub)}">
    <input type="hidden" name="ts" value="${t.ts}"><input type="hidden" name="cat" value="${esc(t.cat)}"><input type="hidden" name="asset" value="${esc(t.asset)}">
    <div class="seg">${['수입', '지출', '이체'].map(k => `<label><input type="radio" name="type" value="${k}" data-change="txType"${k === t.type ? ' checked' : ''}><span class="${cls(k)}">${k}</span></label>`).join('')}</div>
    <div class="frow"><span>날짜</span><span class="two">${fld('date', dateLabel(t.ts))}${fld('time', hm(t.ts))}${t.id ? '' : `<button type="button" class="rep${t.rep ? ' on' : ''}${t.rep === 'inst' ? ' inst' : ''}" data-act="sheet" data-arg="repMenu">${ICON.rep}<small>${repLabel(t)}</small></button>`}</span></div>
    ${t.id ? '' : `<input type="hidden" name="rep" value="${t.rep || ''}"><input type="hidden" name="months" value="${t.months || ''}"><input type="hidden" name="irate" value="${t.irate || ''}">`}
    ${tr && !t.id ? `<div class="frow"><span>금액</span>${money('amt', t.amt)}<button type="button" class="mini" data-act="feeTog">수수료</button></div>${pg.fee || t.fee ? row('수수료', money('fee', t.fee, '출금 자산에서 지출로 잡힘')) : ''}` : row('금액', money('amt', t.amt))}
    ${tr ? prow('출금', 'asset', t.asset) + prow('입금', 'cat', t.cat) : prow('분류', 'cat', t.sub ? `${t.cat} / ${t.sub}` : t.cat) + prow('자산', 'asset', t.asset)
      + (isFx(fa) ? row(`${esc(fa.cur)} 금액`, `<input type="number" step="any" inputmode="decimal" name="famt" value="${t.famt || ''}" data-rate="${fa.rate}" placeholder="넣으면 환율 ${fa.rate} 로 원화 계산">`) : '')}
    <div class="frow"><span>내용</span>${ce('note', t.note, true)}<ul class="sug" hidden></ul></div>
    <div class="gap"></div>
    <div class="frow"><span>메모</span>${ce('memo', t.memo, false)}</div>
    ${t.type === '지출' ? `<label class="chk"><input type="checkbox" name="noPerf"${t.noPerf ? ' checked' : ''}>카드 실적에서 제외</label>` : ''}
    <div class="row save"><button class="pri" name="go" value="save">저장하기</button>${t.id ? '' : '<button name="go" value="more">계속</button>'}</div>
    ${t.id ? `<div class="row acts"><button type="button" data-act="delTx" data-arg="${t.id}">${ICON.del}삭제</button><button type="button" data-act="copyTx" data-arg="${t.id}">${ICON.copy}복사</button><button type="button" data-act="favTx" data-arg="${t.id}">${ICON.star}자주사용</button></div>` : ''}
  </form>${sheet(pg)}`;
}

// 입력 중인 폼 값을 그대로 읽는다 (구분을 바꾸거나 사진을 붙여 화면을 다시 그릴 때 유지)
// 화면을 다시 그리기 전에 입력하던 값을 화면 상태에 옮겨 둔다
const sync = () => { const f = $('form'), pg = topPg(); if (f?.elements && (pg?.p === 'tx' || pg?.p === 'memo')) pg.t = { ...pg.t, ...formVals(f) }; };
const formVals = f => { const v = Object.fromEntries(new FormData(f)); return { ...v, id: Number(v.id) || undefined, noPerf: !!v.noPerf }; };

function saveTx(v) {
  const fa = S.assets.find(a => a.name === v.asset), famt = v.type !== '이체' && isFx(fa) ? Number(v.famt) || 0 : 0;
  const amt = Math.round(toNum(v.amt)) || Math.round(famt * (fa?.rate || 0)); // 원화 금액이 비어 있으면 외화 금액 x 환율
  if (!(amt > 0)) return alert('금액을 확인하세요.');
  if (v.type === '이체' && v.asset === v.cat) return alert('출금과 입금 자산이 같습니다.');
  if (!v.cat) return alert(v.type === '이체' ? '입금 자산을 선택하세요.' : '분류를 선택하세요.');
  const old = S.tx.find(x => x.id === Number(v.id)), tr = v.type === '이체';
  const t = { id: old ? old.id : S.seq++, ts: v.ts.length === 16 ? v.ts + ':00' : v.ts, asset: v.asset, cat: v.cat.trim(), sub: tr ? '' : (v.sub ?? old?.sub ?? '').trim(), note: v.note.trim(), amt, type: v.type, tag: (v.tag ?? old?.tag ?? '').trim(), memo: v.memo.trim() };
  if (famt > 0) Object.assign(t, { cur: fa.cur, famt });
  else if (old?.cur && v.famt === undefined) Object.assign(t, { cur: old.cur, famt: old.famt }); // 엑셀에서 가져온 외화 표기는 지우지 않는다
  if (v.noPerf && !tr) t.noPerf = true;
  const months = Math.round(Number(v.months));
  if (old) S.tx[S.tx.indexOf(old)] = t;
  else if (v.rep === 'inst' && months > 1) { // 할부 : 달마다 한 건씩, 내용 끝에 (회차/개월). 이자가 있으면 회차 금액에 더한다
    const plan = Core.instPlan(amt, months, Number(v.irate) || 0);
    plan.forEach((x, i) => S.tx.push({ ...t, id: i ? S.seq++ : t.id, ts: Core.addMonths(t.ts, i), amt: x.principal + x.interest, note: `${t.note}(${i + 1}/${months})`, ...(i ? {} : { instTotal: amt }) }));
  } else if (EVERY[v.rep]) { // 반복 : 설정을 남기고, 지금까지 돌아온 회차를 내역으로 만든다. 시작일이 아직 안 됐으면 그날 이후 앱을 열 때 생긴다
    const { id, ts, ...tpl } = t;
    S.repeats.push({ id: S.seq++, every: v.rep, start: t.ts, n: 0, tpl });
    Core.runRepeats(S, nowTs());
  } else {
    S.tx.push(t);
    if (tr && toNum(v.fee) > 0) { S.tx.push({ ...t, id: S.seq++, type: '지출', cat: '기타', sub: '', note: '수수료', amt: Math.round(toNum(v.fee)) }); Core.addCat(S, '지출', '기타'); }
  }
  if (!tr) Core.addCat(S, t.type, t.cat);
  V.ym = t.ts.slice(0, 7);
  if (v.go === 'more') { save(); topPg().t = { type: t.type, ts: t.ts, asset: t.asset }; render(); } else done();
}

const pageFavs = () => `${head('자주 사용하는 내역')}<ul class="list">${S.favs.map((f, i) => `<li data-act="useFav" data-arg="${i}"><span class="c">${esc(f.type === '이체' ? '이체' : f.cat)}</span>
  <span class="m"><b>${esc(f.note)}</b><small>${esc(f.type === '이체' ? `${f.asset} → ${f.cat}` : f.asset)}</small></span><span class="a ${cls(f.type)}">${f.amt ? won(f.amt) : ""}</span>
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

// [가계부앱] 2026-11-23 : 통계 원 그래프. 12시에서 시계 방향으로 큰 분류부터
function pie(rows, total) {
  const W = 412, H = 330, cx = 192, cy = 165, R = 62, pt = (a, r, dx = 0, dy = 0) => `${(cx + dx + r * Math.sin(a)).toFixed(1)},${(cy + dy - r * Math.cos(a)).toFixed(1)}`;
  const short = c => { const ch = [...c]; return ch.length > 9 ? ch.slice(0, 8).join('') + '…' : c; };
  let acc = 0, slices = '', tip = '';
  const labels = [];
  rows.forEach(([c, v], i) => {
    const a0 = acc / total * 2 * Math.PI, a1 = (acc += v) / total * 2 * Math.PI, mid = (a0 + a1) / 2, sel = V.statSel === c;
    const dx = sel ? 10 * Math.sin(mid) : 0, dy = sel ? -10 * Math.cos(mid) : 0;
    slices += rows.length === 1 ? `<circle cx="${cx}" cy="${cy}" r="${R}" fill="${PAL[0]}"/>`
      : `<path data-act="statSel" data-arg="${esc(c)}" fill="${PAL[i % PAL.length]}" d="M${cx + dx},${cy + dy} L${pt(a0, R, dx, dy)} A${R},${R} 0 ${a1 - a0 > Math.PI ? 1 : 0} 1 ${pt(a1, R, dx, dy)} Z"/>`;
    if (v / total >= 0.03) labels.push({ c, i, mid, right: mid < Math.PI, y: cy - (R + 34) * Math.cos(mid), pct: (v / total * 100).toFixed(1) });
    if (sel) tip = `<g class="tip"><rect x="${cx - 72}" y="${cy - R - 22}" width="124" height="48" rx="3" stroke="${PAL[i % PAL.length]}"/><text x="${cx - 62}" y="${cy - R - 3}">${esc(short(c))}</text><text x="${cx - 62}" y="${cy - R + 17}" class="b">${won(v)}</text></g>`;
  });
  // 같은 쪽 이름표끼리 겹치지 않게 위에서부터 36px 간격을 둔다
  for (const side of [true, false]) { let last = -99; for (const l of labels.filter(l => l.right === side).sort((a, b) => a.y - b.y)) { l.y = Math.max(l.y, last + 36); last = l.y; } }
  const lab = labels.map(l => { const x = l.right ? cx + R + 36 : cx - R - 40, e = l.right ? x - 6 : x + 6;
    return `<path class="ld" stroke="${PAL[l.i % PAL.length]}" d="M${pt(l.mid, R)} C${pt(l.mid, R + 26)} ${e + (l.right ? -28 : 28)},${l.y.toFixed(1)} ${e},${l.y.toFixed(1)}"/><text x="${x}" y="${(l.y - 2).toFixed(1)}" text-anchor="${l.right ? 'start' : 'end'}" class="b">${esc(short(l.c))}</text><text x="${x}" y="${(l.y + 15).toFixed(1)}" text-anchor="${l.right ? 'start' : 'end'}">${l.pct} %</text>`; }).join('');
  return `<svg class="pie2" viewBox="0 0 ${W} ${H}" role="img" aria-label="분류별 비율">${lab}${slices}${tip}</svg>`;
}

// 통계에서 분류를 누르면 : 그 달 총액, 최근 8개월 추이, 소분류별 합계, 그 달 내역
function pageStatCat(pg) {
  const mine = t => t.type === pg.type && t.cat === pg.cat, yms = [...Array(8)].map((_, i) => Core.shiftYm(pg.ym, i - 7));
  const vals = yms.map(ym => S.tx.reduce((a, t) => a + (t.ts.startsWith(ym) && mine(t) ? t.amt : 0), 0));
  const list = S.tx.filter(t => t.ts.startsWith(pg.ym) && mine(t)).sort(desc);
  // 세로 눈금은 0 부터가 아니라 값이 있는 범위에 맞춘다 (위아래 10% 여유, 눈금 단위는 1·2.5·5)
  const mn = Math.min(...vals), mx = Math.max(...vals), range = (mx - mn) || mx || 1, raw = range * 1.2 / 3, pw = 10 ** Math.floor(Math.log10(raw)), step = [1, 2.5, 5, 10].find(k => k * pw >= raw) * pw;
  const lo = Math.max(0, Math.floor((mn - range * 0.1) / step) * step), hi = Math.max(lo + step, Math.ceil((mx + range * 0.1) / step) * step), ticks = [...Array(Math.round((hi - lo) / step) + 1)].map((_, n) => lo + step * n);
  const W = 412, H = 210, L = 52, T = 14, B = 38, x = i => L + 24 + i * (W - L - 48) / 7, y = v => T + (H - T - B) * (1 - (v - lo) / (hi - lo));
  const col = pg.color || 'var(--accent)', si = pg.sel, tw = si == null ? 0 : won(vals[si]).length * 8 + 22, tx = si == null ? 0 : Math.min(W - tw - 4, Math.max(L + 4, x(si) - tw / 2)), up = si != null && y(vals[si]) > H - B - 50;
  return `${head(pg.cat, monthNav('pmonth', ymLabel(pg.ym)))}<div class="tot"><small>월총액</small><b>${won(vals[7])}</b></div>
    <svg class="chart bchart lchart" viewBox="0 0 ${W} ${H}" role="img" aria-label="최근 8개월 추이">
      ${ticks.map(v => `<line x1="${L}" x2="${W}" y1="${y(v)}" y2="${y(v)}"/><text x="${L - 6}" y="${y(v) + 4}" text-anchor="end">${v >= 1000 ? (v / 1000).toLocaleString('ko-KR') + 'k' : v}</text>`).join('')}<line x1="${L}" x2="${L}" y1="${T}" y2="${y(lo)}"/>
      <rect class="cur" x="${x(7) - 20}" y="${T}" width="40" height="${y(lo) - T}"/>
      ${yms.map((ym, i) => `<text x="${x(i)}" y="${H - 14}" text-anchor="middle"${i === 7 ? ' class="curt"' : ''}>${Number(ym.slice(5))}월</text>`).join('')}
      <polyline style="stroke:${col}" points="${vals.map((v, i) => `${x(i)},${y(v)}`).join(' ')}"/>
      ${vals.map((v, i) => `${i === si ? `<circle cx="${x(i)}" cy="${y(v)}" r="11" style="fill:${col};opacity:.3"/>` : ''}<circle cx="${x(i)}" cy="${y(v)}" r="${i === 7 ? 6 : 4.5}" style="${i === si ? `fill:var(--card);stroke:${col};stroke-width:2.5` : `fill:${col}`}"/><circle class="hit" data-act="ptSel" data-arg="${i}" cx="${x(i)}" cy="${y(v)}" r="16"/>`).join('')}
      ${si == null ? '' : `<g class="ptip"><path d="M${x(si) - 6},${y(vals[si]) + (up ? -16 : 16)} l6,${up ? 7 : -7} l6,${up ? -7 : 7}z"/><rect x="${tx}" y="${y(vals[si]) + (up ? -46 : 16)}" width="${tw}" height="30" rx="5"/><text x="${tx + tw / 2}" y="${y(vals[si]) + (up ? -26 : 36)}" text-anchor="middle">${won(vals[si])}</text></g>`}</svg>
    ${subBreak(list)}${dayList(list)}`;
}

function viewStats() {
  const [from, to, label] = statPeriod(), list = Core.between(S.tx, from, to), s = Core.sums(list);
  const rows = Core.catSums(list, V.statType), total = rows.reduce((a, r) => a + r[1], 0);
  const color = i => PAL[i % PAL.length];
  const nav = V.sMode === 'range' ? `<div class="month"><input type="date" value="${from}" data-change="sFrom">~<input type="date" value="${to}" data-change="sTo"></div>` : monthNav('sNav', label);
  return `<header>${nav}<select data-change="sMode">${[['week', '주간'], ['month', '월간'], ['year', '연간'], ['range', '기간']].map(([k, l]) => `<option value="${k}"${V.sMode === k ? ' selected' : ''}>${l}</option>`).join('')}</select></header>
    <div class="tabs">${['수입', '지출'].map(k => `<button data-act="stat" data-arg="${k}"${V.statType === k ? ' class="on"' : ''}>${k} ${won(k === '수입' ? s.income : s.expense)}</button>`).join('')}</div>
    ${total ? pie(rows, total) : '<p class="empty">데이터가 없습니다.</p>'}
    <ul class="list">${rows.map(([c, v], i) => `<li data-act="statCat" data-arg="${esc(c)}"><span class="pct" style="background:${color(i)}">${Math.round(v / total * 100)}%</span><span class="m"><b>${esc(c)}</b></span><span class="a">${won(v)}</span></li>`).join('')}</ul>`;
}

// ---------- 자산 ----------
// [가계부앱] 2026-11-23 : 외화 자산. 정해 둔 환율로 환전해 두고 외화로 결제하는 계좌를 가정한다
// 원화 잔액은 다른 자산과 똑같이 내역으로 움직이고, 외화 잔액은 원화 잔액 / 환율 로 계산해 보여 준다
// ponytail: 환율은 자산에 하나만 둔다. 다른 환율로 추가 환전하면 평균 환율을 직접 고쳐 적는다. 환전 건별 환율이 필요해지면 내역에 환율을 남기는 방식으로 바꾼다
const isFx = a => !!(a && a.cur && a.rate > 0);
const fx = (a, bal) => (isFx(a) ? `${esc(a.cur)} ${Math.round(bal / a.rate).toLocaleString('ko-KR')} · 환율 ${a.rate}` : '');
const assetMenu = withAdd => (V.aMenu ? `<div class="modal clear" data-act="aMenu"><div class="menu amenu" data-act="nop">${[...(withAdd ? [['new', '추가']] : []), ['aHide', '표시/숨김'], ['aDel', '삭제'], ['aOrder', '순서 변경']].map(([k, l]) => `<button data-act="aGo" data-arg="${k}">${l}</button>`).join('')}</div></div>` : '');
// 카드 실적사용금액. 실적 기준이 "3개월 평균"이면 이번 달 포함 최근 3개월의 평균
const perfOf = (a, ym) => (a.perfBase === 'avg3' ? Math.round([0, -1, -2].reduce((x, n) => x + Core.card(S, a.name, Core.shiftYm(ym, n)).perf, 0) / 3) : Core.card(S, a.name, ym).perf);
function viewAssets() {
  const bal = Core.balances(S), tot = Core.totals(S), ym = today().slice(0, 7);
  const cards = Object.fromEntries(S.assets.filter(isCard).map(a => [a.name, Core.card(S, a.name, ym)]));
  const row = a => {
    const v = bal[a.name] || 0, c = cards[a.name], open = V.openMemo.has(a.name), pf = c && a.perf ? perfOf(a, ym) : 0;
    return `<li data-act="asset" data-arg="${esc(a.name)}">${a.memo ? `<button class="ic sm" data-act="memoTog" data-arg="${esc(a.name)}" aria-label="메모 ${open ? '접기' : '펼치기'}">${open ? ICON.minus : ICON.plus}</button>` : '<i class="sm0"></i>'}<span class="m"><b>${esc(a.name)}</b>${c && a.perf && !a.deleted && pf < a.perf ? `<span class="perfl"><i class="pbar"><u style="width:${Math.min(100, pf / a.perf * 100)}%"></u></i><small>실적 ${Math.floor(pf / a.perf * 100)}%</small></span>` : ''}${a.deleted ? '<small>삭제됨</small>' : a.hidden ? '<small>숨김</small>' : ''}${isFx(a) ? `<small>${fx(a, bal[a.name] || 0)}</small>` : ''}</span>
      ${c && !a.deleted ? `<span class="a">${won(c.due)}</span><span class="a out">${won(c.unpaid)}</span>` : `<span class="a ${sign(v)}">${won(v)}</span>`}</li>
      ${a.memo && open ? `<li class="note"><pre>${esc(a.memo)}</pre></li>` : ''}`;
  };
  const live = S.assets.filter(a => !a.deleted && !a.hidden), rest = S.assets.filter(a => a.deleted || a.hidden);
  const groups = [...new Set([...S.groups, ...live.map(a => a.group)])];
  const gHead = (g, items) => {
    if (!items.every(isCard)) { const v = items.reduce((s, a) => s + (bal[a.name] || 0), 0); return `<h3 class="gh">${esc(g)}<span class="${sign(v)}">${won(v)}</span></h3>`; }
    const sum = k => items.reduce((s, a) => s + cards[a.name][k], 0);
    return `<h3 class="gh">${esc(g)}<span class="col"><small>결제예정금액</small>${won(sum('due'))}</span><span class="col out"><small>미결제금액</small>${won(sum('unpaid'))}</span></h3>`;
  };
  const menu = assetMenu(true);
  return `<header><b>자산</b><span class="hic"><button class="ic" data-act="go" data-arg="trend" aria-label="추이">${ICON.bars}</button><button class="ic" data-act="aMenu" aria-label="메뉴">${ICON.dots}</button></span></header>${menu}
    <div class="sum"><div>자산<b class="in">${num(tot.assets)}</b></div><div>부채<b class="out">${num(tot.liabilities)}</b></div><div>합계<b>${num(tot.net)}</b></div></div>
    ${groups.map(g => { const items = live.filter(a => a.group === g); return items.length ? `${gHead(g, items)}<ul class="list alist">${items.map(row).join('')}</ul>` : ''; }).join('')}
    ${rest.length ? `<details><summary>숨김·삭제된 자산 ${rest.length}개 (삭제된 자산은 합계에서 제외)</summary><ul class="list alist">${rest.map(row).join('')}</ul></details>` : ''}`;
}

// [가계부앱] 2026-11-23 : 자산 탭 ⋮ 메뉴의 표시/숨김 · 삭제 · 순서 변경 화면. 그룹별로 묶어 보여 준다
const grouped = (rowFn, all) => { const live = S.assets.filter(a => !a.deleted); return [...new Set([...S.groups, ...live.map(a => a.group)])].map(g => { const items = live.filter(a => a.group === g); return items.length ? `<h3 class="gh">${esc(g)}</h3><ul class="list alist">${items.map(rowFn).join('')}</ul>` : ''; }).join(''); };
function pageAHide() {
  const bal = Core.balances(S);
  return head('표시/숨김 설정') + grouped(a => { const v = bal[a.name] || 0; return `<li data-act="aEye" data-arg="${esc(a.name)}"${a.hidden ? ' class="off"' : ''}><span class="m"><b>${esc(a.name)}</b></span><span class="a ${isCard(a) ? 'out' : sign(v)}">${won(Math.abs(v))}</span><span class="pen">${a.hidden ? ICON.eyeOff : ICON.eye}</span></li>`; });
}
function pageADel() {
  return head('삭제') + '<p class="cap pad">삭제해도 이미 적은 내역은 남습니다. 삭제한 자산은 합계에서 빠집니다.</p>' + grouped(a => `<li><button class="ic del" data-act="aDelete" data-arg="${esc(a.name)}" aria-label="${esc(a.name)} 삭제">−</button><span class="m"><b>${esc(a.name)}</b></span></li>`);
}
function pageAOrder() {
  return head('순서 변경') + '<p class="cap pad">오른쪽 손잡이(≡)를 잡고 끌어서 같은 그룹 안에서 옮깁니다.</p>' + grouped(a => `<li data-name="${esc(a.name)}"><span class="m"><b>${esc(a.name)}</b></span><span class="grip" aria-label="${esc(a.name)} 옮기기">≡</span></li>`);
}

// 세로 눈금 : 값 범위에 위아래 10% 여유를 두고 보기 좋은 단위(1·2·2.5·5)로 끊는다. zero 면 0 부터
function axis(vals, zero) {
  const mn = zero ? 0 : Math.min(...vals), mx = Math.max(...vals), range = (mx - mn) || Math.abs(mx) || 1, raw = range * 1.2 / 3, pw = 10 ** Math.floor(Math.log10(raw)), step = [1, 2, 2.5, 5, 10].find(k => k * pw >= raw) * pw;
  const lo = zero ? 0 : Math.floor((mn - range * 0.1) / step) * step, hi = Math.max(lo + step, Math.ceil((mx + (zero ? 0 : range * 0.1)) / step) * step);
  return { lo, hi, ticks: [...Array(Math.round((hi - lo) / step) + 1)].map((_, n) => lo + step * n), fmt: v => (v === 0 ? '0' : Math.abs(v) >= 1e6 && v % 5e5 === 0 ? v / 1e6 + 'M' : (v / 1000).toLocaleString('ko-KR') + 'k') };
}
// 그래프 두 개 : 잔액(선)과 들어온 돈·나간 돈(막대). 탭의 단위를 따른다(일일 = 그 달의 날짜별, 월별 = 그 해의 달별, 연별 = 최근 6년, 전체통계 = 최근 6개월). 점이 6개 이하면 값을 아래에 숫자로도 적는다
// 점을 누르면 금액 말풍선(pg.sel), 막대를 누르면 그 달 두 값(pg.bsel)이 뜬다. 자산 상세와 전체통계가 같이 쓴다
function charts(pg, bal, io_, names, labs) {
  const yms = [...Array(6)].map((_, i) => Core.shiftYm(pg.ym, i - 5)), n = bal.length, wide = n > 6, bw = n > 12 ? 3 : wide ? 6 : 11, hw = n > 12 ? 5 : wide ? 13 : 26, W = 412, LX = 52, x = i => LX + (wide ? 20 : 30) + i * (W - LX - (wide ? 36 : 60)) / (n - 1); // 점이 6개보다 많으면(월별 12달) 숫자는 빼고 눌러서 본다
  const frame = (A, H, T, body, labels) => { const y = v => T + (H - T - 62) * (1 - (v - A.lo) / (A.hi - A.lo));
    return `<svg class="chart bchart achart" viewBox="0 0 ${W} ${H}" role="img">${A.ticks.map(v => `<line x1="${LX}" x2="${W}" y1="${y(v)}" y2="${y(v)}"/><text x="${LX - 6}" y="${y(v) + 4}" text-anchor="end">${A.fmt(v)}</text>`).join('')}<line x1="${LX}" x2="${LX}" y1="${T}" y2="${y(A.lo)}"/>${bal.map((_, i) => `<text x="${x(i)}" y="${H - 40}" text-anchor="middle">${labs ? labs[i] : Number(yms[i].slice(5)) + '월'}</text>${wide ? '' : labels(i, H)}`).join('')}${body(y)}</svg>`; };
  const A1 = axis(bal), A2 = axis(io_.flat(), true), si = pg.sel, bi = pg.bsel;
  const tip = y => { if (si == null) return ''; const v = bal[si], tw = won(v).length * 8 + 22, tx = Math.min(W - tw - 4, Math.max(LX + 4, x(si) - tw / 2)), up = y(v) > 70;
    return `<g class="ptip"><path d="M${x(si) - 6},${y(v) + (up ? -16 : 16)} l6,${up ? 7 : -7} l6,${up ? -7 : 7}z"/><rect x="${tx}" y="${y(v) + (up ? -46 : 16)}" width="${tw}" height="30" rx="5"/><text x="${tx + tw / 2}" y="${y(v) + (up ? -26 : 36)}" text-anchor="middle">${won(v)}</text></g>`; };
  const btip = () => { if (bi == null) return ''; const tw = 150, tx = Math.min(W - tw - 4, Math.max(LX + 4, x(bi) - tw - 16));
    return `<g class="btip"><rect x="${tx}" y="70" width="${tw}" height="48"/><text x="${tx + 12}" y="90">${names[0]} <tspan class="in">${won(io_[bi][0])}</tspan></text><text x="${tx + 12}" y="109">${names[1]} <tspan class="out">${won(io_[bi][1])}</tspan></text></g>`; };
  return frame(A1, 230, 14, y => `<polyline points="${bal.map((v, i) => `${x(i)},${y(v)}`).join(' ')}"/>${bal.map((v, i) => `${i === si ? `<circle class="halo" cx="${x(i)}" cy="${y(v)}" r="11"/>` : ''}<circle${i === si ? ' class="now"' : ''} cx="${x(i)}" cy="${y(v)}" r="${n > 12 ? 2.5 : 4.5}"/><circle class="hit" data-act="ptSel" data-arg="${i}" cx="${x(i)}" cy="${y(v)}" r="${n > 12 ? 6 : 18}"/>`).join('')}${tip(y)}`, (i, H) => `<text class="v" x="${x(i)}" y="${H - 24}" text-anchor="middle">${num(bal[i])}</text>`)
    + frame(A2, 220, 14, y => io_.map(([inn, out], i) => `<rect class="bi${i === bi ? ' on' : ''}" x="${x(i) - bw - 1}" width="${bw}" y="${y(inn)}" height="${y(0) - y(inn)}"/><rect class="bo${i === bi ? ' on' : ''}" x="${x(i) + 1}" width="${bw}" y="${y(out)}" height="${y(0) - y(out)}"/><rect class="hit" data-act="barSel" data-arg="${i}" x="${x(i) - hw}" width="${hw * 2}" y="14" height="${y(0) - 14}"/>`).join('') + btip(), (i, H) => `<text class="v in" x="${x(i)}" y="${H - 24}" text-anchor="middle">${num(io_[i][0])}</text><text class="v out" x="${x(i)}" y="${H - 10}" text-anchor="middle">${num(io_[i][1])}</text>`);
}

// [가계부앱] 2026-11-23 : 자산 종류별 요약 줄. 저축은 금리·만기·납입 회차·만기 예상액, 카드는 결제일·연회비, 대출은 남은 원금·이자, 보험은 보험료·만기
// ponytail: 이자는 단리·세전으로만 계산한다(적금 = 월 납입액 x 연이율/12 x 회차 합). 복리나 세후가 필요해지면 자산에 이자 방식을 둔다
function assetFacts(a, bal, L) {
  const g = a.group, f = [], t = today(), dday = d => { const n = Math.round((Date.parse(d) - Date.parse(t)) / 864e5); return n >= 0 ? `D-${n}` : '만기 지남'; };
  const months = (x, y) => (Number(y.slice(0, 4)) - Number(x.slice(0, 4))) * 12 + Number(y.slice(5, 7)) - Number(x.slice(5, 7));
  if (isCard(a)) {
    f.push(`결제일 ${a.payDay || 1}일`);
    if (a.payFrom) f.push(`결제 계좌 ${a.payFrom}`);
    if (a.annualFee) f.push(`연회비 ${won(a.annualFee)}${a.annualMonth ? ` (${a.annualMonth}월)` : ''}`);
  } else if (g === '저축') {
    if (a.irate) f.push(`연 ${a.irate}%`);
    if (a.endDate) f.push(`만기 ${a.endDate} (${dday(a.endDate)})`);
    if (a.monthly) {
      const total = a.startDate && a.endDate ? months(a.startDate, a.endDate) : 0, n = L.filter(r => r.d > 0).length;
      f.push(`월 ${won(a.monthly)}${a.dueDay ? ` · 매월 ${a.dueDay}일` : ''}`, total ? `납입 ${n}/${total}회` : `납입 ${n}회`);
      if (total && a.irate) f.push(`만기 예상 ${won(Math.round(a.monthly * total + a.monthly * a.irate / 1200 * total * (total + 1) / 2))} (세전)`);
    } else if (a.irate && bal > 0) f.push(`한 달 이자 약 ${won(Math.round(bal * a.irate / 1200))} (세전)`);
  } else if (/대출|마이너스/.test(g)) {
    const owe = Math.max(0, -bal);
    f.push(`남은 원금 ${won(owe)}`);
    if (a.irate) f.push(`연 ${a.irate}%`, `이번 달 이자 약 ${won(Math.round(owe * a.irate / 1200))}`);
    if (a.monthly || a.dueDay) f.push(`${a.monthly ? '월 상환 ' + won(a.monthly) : '상환'}${a.dueDay ? ` · 매월 ${a.dueDay}일` : ''}`);
    if (a.limit) f.push(`한도 ${won(a.limit)} 중 ${Math.round(owe / a.limit * 100)}% 사용`);
  } else if (g === '보험') {
    if (a.monthly || a.dueDay) f.push(`${a.monthly ? '월 보험료 ' + won(a.monthly) : '보험료'}${a.dueDay ? ` · 매월 ${a.dueDay}일` : ''}`);
    if (a.endDate) f.push(`만기 ${a.endDate} (${dday(a.endDate)})`);
  }
  if (a.goal > 0) f.push(bal >= a.goal ? `목표 ${won(a.goal)} 달성` : `목표 ${won(a.goal)} 중 ${Math.floor(Math.max(0, bal) / a.goal * 100)}% · ${won(a.goal - Math.max(0, bal))} 남음`);
  return f.length ? `<p class="facts">${f.map(x => `<span>${esc(x)}</span>`).join('')}</p>` : '';
}

// 자산 상세 : 일일(누적잔액 포함) · 월별 · 연별
function pageAsset(pg) {
  const a = S.assets.find(x => x.name === pg.name);
  if (!a) return head('자산') + '<p class="empty">자산이 없습니다.</p>';
  const L = Core.ledger(S, a.name), y = pg.ym.slice(0, 4);
  const tabs = `<div class="tabs">${[['day', '일일'], ['month', '월별'], ['year', '연별']].map(([k, n]) => `<button data-act="ptab" data-arg="${k}"${pg.tab === k ? ' class="on"' : ''}>${n}</button>`).join('')}</div>`;
  const tools = `<span class="hic"><button class="ic" data-act="aChart" aria-label="${pg.chart ? '내역 보기' : '그래프 보기'}">${pg.chart ? ICON.rows : ICON.bars}</button><button class="ic" data-act="assetInfo" aria-label="자산 정보 수정">${ICON.pen}</button></span>`;
  if (pg.tab !== 'day') { // 월·연 단위로 묶어 입금·출금·기말 잔액
    const n = pg.tab === 'month' ? 7 : 4, m = new Map();
    for (const r of L) { const k = r.t.ts.slice(0, n), o = m.get(k) || { inn: 0, out: 0 }; if (r.d > 0) o.inn += r.d; else o.out -= r.d; o.bal = r.bal; m.set(k, o); }
    const rows = [...m].reverse().filter(([k]) => pg.tab === 'year' || k.startsWith(y));
    // [가계부앱] 2026-11-23 : 월별·연별 탭도 사용기간(그 해)·합계 줄을 두고, 그래프 보기는 최근 6년을 해마다 보여 준다
    const yr = L.filter(r => r.t.ts.startsWith(y)), inn = yr.reduce((s, r) => s + (r.d > 0 ? r.d : 0), 0), out = yr.reduce((s, r) => s + (r.d < 0 ? -r.d : 0), 0), cum = Core.balanceAt(S, a.name, y + '-12-31');
    // 그래프 : 월별 탭은 그 해 1~12월, 연별 탭은 최근 6년
    const ks = pg.tab === 'month' ? [...Array(12)].map((_, i) => `${y}-${String(i + 1).padStart(2, '0')}`) : [...Array(6)].map((_, i) => String(Number(y) - 5 + i));
    const body = pg.chart ? charts(pg, ks.map(k => Core.balanceAt(S, a.name, k.length === 7 ? Core.monthEnd(k) : k + '-12-31')), ks.map(k => { const o = m.get(k) || { inn: 0, out: 0 }; return [o.inn, o.out]; }), ['입금', '출금'], ks.map(k => (k.length === 7 ? Number(k.slice(5)) + '월' : k.slice(2) + '년')))
      : `<ul class="list">${rows.map(([k, o]) => `<li><span class="m"><b>${pg.tab === 'month' ? Number(k.slice(5)) + '월' : k + '년'}</b></span><span class="a in">${won(o.inn)}</span><span class="a out">${won(o.out)}</span><span class="a ${sign(o.bal)}">${won(isCard(a) ? Math.abs(o.bal) : o.bal)}</span></li>`).join('') || '<p class="empty">데이터가 없습니다.</p>'}</ul>`;
    pg.sel = Math.min(pg.sel ?? 99, ks.length - 1) === pg.sel ? pg.sel : null; pg.bsel = Math.min(pg.bsel ?? 99, ks.length - 1) === pg.bsel ? pg.bsel : null;
    return `${head(a.name, monthNav('pmonth', y + '년'))}${tabs}
      <div class="period"><span><small>사용기간</small><b>${sd(y + '-01-01')} ~ ${sd(y + '-12-31')}</b></span>${tools}</div>
      <div class="sum"><div>입금<b class="in">${num(inn)}</b></div><div>출금<b class="out">${num(out)}</b></div><div>합계<b>${num(inn - out)}</b></div>${pg.tab === 'month' ? `<div>누적잔액<b class="${sign(cum)}">${num(isCard(a) ? Math.abs(cum) : cum)}</b></div>` : ''}</div>
      ${pg.chart ? '' : '<p class="cap">입금 / 출금 / 잔액</p>'}${body}`;
  }
  const from = pg.ym + '-01', to = Core.monthEnd(pg.ym), rows = L.filter(r => r.t.ts.startsWith(pg.ym));
  const list = rows.map(r => r.t).reverse(), inn = rows.reduce((s, r) => s + (r.d > 0 ? r.d : 0), 0), out = rows.reduce((s, r) => s + (r.d < 0 ? -r.d : 0), 0);
  const days = []; for (let d = from; d <= to; d = Core.dAdd(d, 1)) days.push(d); // 일일 탭 그래프는 그 달의 날짜별
  const cum = Core.balanceAt(S, a.name, to), c = isCard(a) ? Core.card(S, a.name, pg.ym) : null;
  const sum = items => { const f = Core.flow(items, a.name); return { income: f.income + f.tin, expense: f.expense + f.tout }; };
  return `${head(a.name, monthNav('pmonth', ymLabel(pg.ym)))}${tabs}
    <div class="period"><span><small>사용기간</small><b>${sd(from)} ~ ${sd(to)}</b></span>${tools}</div>
    <div class="sum"><div>입금<b class="in">${num(inn)}</b></div><div>출금<b class="out">${num(out)}</b></div><div>합계<b>${num(inn - out)}</b></div><div>누적잔액<b class="${sign(cum)}">${num(c ? Math.abs(cum) : cum)}</b></div></div>
    ${c && a.perf ? `<div class="sum perf"><div>실적 (${sd(from)} ~ ${sd(to)})<b>${won(a.perf)}${perfOf(a, pg.ym) >= a.perf ? ' <i class="ok">✓</i>' : ''}</b></div><div>실적사용금액${a.perfBase === 'avg3' ? ' (3개월 평균)' : ''}<b>${won(perfOf(a, pg.ym))}</b></div><div>남은금액<b class="rem">${won(a.perf - perfOf(a, pg.ym))}</b></div></div>` : ''}
    ${assetFacts(a, cum, L)}${isFx(a) ? `<p class="cap">${fx(a, cum)}</p>` : ''}${a.memo ? `<pre class="note">${esc(a.memo)}</pre>` : ''}
    ${pg.chart ? charts(pg, days.map(d => Core.balanceAt(S, a.name, d)), days.map(d => rows.filter(r => r.t.ts.startsWith(d)).reduce((o, r) => { if (r.d > 0) o[0] += r.d; else o[1] -= r.d; return o; }, [0, 0])), ['입금', '출금'], days.map(d => { const n = Number(d.slice(8)); return n === 1 || n % 5 === 0 ? n + '일' : ''; })) : dayList(list, { name: a.name, bal: new Map(L.map(r => [r.t.id, r.bal])), sum })}
    ${c ? '<button class="fab two" data-act="pay">결제</button>' : ''}${fab()}`;
}

// [가계부앱] 2026-11-23 : 자산정보·자산추가 화면을 원본 구성으로. 그룹에 따라 칸이 달라진다(카드 : 결제 계좌·정산일·결제일, 체크카드 : 결제 계좌, 마이너스 통장·대출 : 안내)
// 고치던 값은 pg.d 에 들고 있다가 그룹을 바꿔 다시 그릴 때 쓴다
// ponytail: 그룹 고르기는 폰 기본 선택창을 쓴다. 문자 연동 칸(전화번호·문자연결어·어플)은 기능이 없어 뺐다
const GROUPS_ALL = ['현금', '은행', '카드', '체크카드', '선불식카드', '저축', '투자', '마이너스 통장', '대출', '보험', '기타'];
const mdd = d => `${d.slice(5, 7)}.${d.slice(8)}`;
// 정산일 s, 결제일 p 일 때 [지난 사용기간, 이번 사용기간] 을 "10.01 ~ 10.31 (결제: 11.14)" 꼴로
function cardPeriods(s, p) {
  const t = today(), clamp = (ym, d) => { const e = Core.monthEnd(ym); return d >= Number(e.slice(8)) ? e : `${ym}-${String(d).padStart(2, '0')}`; };
  const start = clamp(t.slice(0, 7), s) <= t ? t.slice(0, 7) : Core.shiftYm(t.slice(0, 7), -1);
  return [-1, 0].map(n => { const ym = Core.shiftYm(start, n), from = clamp(ym, s), to = Core.dAdd(clamp(Core.shiftYm(ym, 1), s), -1), pay = clamp(Core.shiftYm(to.slice(0, 7), p > Number(to.slice(8)) && s !== 1 ? 0 : 1), p); return `${mdd(from)} ~ ${mdd(to)} (결제: ${mdd(pay)})`; });
}
function pageAssetInfo(pg) {
  const st = S.assets.find(x => x.name === pg.name), d = pg.d, name = pg.name || '';
  const a = { name: '', group: S.groups[0], inTotal: true, hidden: false, deleted: false, ...st, ...d, ...(d && { inTotal: !!d.inTotal, hidden: !!d.hidden, xfer: !!d.xfer }) };
  const g = a.group, sav = g === '저축', loan = /대출|마이너스/.test(g), ins = g === '보험';
  const row = (label, inner) => `<label class="frow"><span>${label}</span>${inner}</label>`, card = isCard(a), sDay = Math.round(toNum(a.settleDay)) || 1, pDay = Math.round(toNum(a.payDay)) || 1;
  const banks = S.assets.filter(x => !x.deleted && !x.group.includes('카드') && x.name !== name), per = card ? cardPeriods(sDay, pDay) : null;
  return `${head(name ? '자산정보' : '자산추가', name ? `<button class="ic" data-act="toggleDel" aria-label="${a.deleted ? '복원' : '삭제'}">${a.deleted ? '복원' : ICON.del}</button>` : '')}<form data-form="asset" class="form">
    <input type="hidden" name="orig" value="${esc(name)}">
    ${row('그룹', `<select name="group" data-change="aGroup">${[...new Set([...GROUPS_ALL, ...S.groups, a.group])].map(g => `<option${g === a.group ? ' selected' : ''}>${esc(g)}</option>`).join('')}</select>`)}
    ${row('이름', `<input name="name" value="${esc(a.name)}" autocomplete="off" required>`)}
    ${a.group === '체크카드' ? '' : row('금액', money('bal', d?.bal ?? (name ? Core.balances(S)[name] || 0 : 0)))}
    ${/마이너스|대출/.test(a.group) ? `<p class="cap ind">${esc(a.group)}을 입력하실 때에는 금액에 '-' 를 함께 입력하셔야, 부채에 합산 됩니다. '-' 가 없으면 자산에 합산됩니다.</p>` : ''}
    ${a.group.includes('카드') && !/선불/.test(a.group) ? row('결제', `<select name="payFrom"><option value=""></option>${banks.map(x => `<option${x.name === a.payFrom ? ' selected' : ''}>${esc(x.name)}</option>`).join('')}</select>`) : ''}
    ${row('메모', `<textarea name="memo" rows="${Math.max(1, (a.memo || '').split('\n').length)}">${esc(a.memo || '')}</textarea>`)}
    ${name ? '<p class="cap ind">금액을 바꾸면 차액이 "잔액수정" 내역으로 들어갑니다.</p>' : ''}
    ${/은행|저축|투자/.test(g) ? row('목표 금액', money('goal', a.goal || '', '없으면 비워 두기')) : ''}
    ${card ? `<div class="gap"></div>
      ${row('정산일', `<input inputmode="numeric" autocomplete="off" data-unit=" 일" name="settleDay" value="${sDay} 일">`)}
      ${row('결제일', `<input inputmode="numeric" autocomplete="off" data-unit=" 일" name="payDay" value="${pDay} 일">`)}
      <div class="pbox"><span>결제예정금액</span><b>${per[0]}</b><span>미결제금액</span><b>${per[1]}</b></div>
      ${sDay !== 1 ? '<p class="cap ind">정산일이 1일이 아니어도 금액 계산은 아직 1일~말일 기준입니다.</p>' : ''}
      ${row('실적 기준', money('perf', a.perf || '', '예: 300,000원'))}
      ${row('연회비', money('annualFee', a.annualFee || '', '없으면 비워 두기'))}
      ${row('연회비 청구 월', `<input inputmode="numeric" autocomplete="off" data-unit=" 월" name="annualMonth" value="${a.annualMonth ? a.annualMonth + ' 월' : ''}" placeholder="넣으면 그 달 1일에 알림">`)}` : ''}
    ${sav || loan || ins ? `<div class="gap"></div>
      ${ins ? '' : row('금리 (연 %)', `<input type="number" step="any" inputmode="decimal" name="irate" value="${a.irate || ''}" placeholder="예: 3.5">`)}
      ${sav ? row('시작일', `<input type="date" name="startDate" value="${a.startDate || ''}">`) : ''}
      ${sav || ins ? row('만기일', `<input type="date" name="endDate" value="${a.endDate || ''}">`) : ''}
      ${row(sav ? '월 납입액' : ins ? '월 보험료' : '월 상환액', money('monthly', a.monthly || '', sav ? '자유 입출금이면 비워 두기' : ''))}
      ${row(loan ? '상환일' : '납입일', `<input inputmode="numeric" autocomplete="off" data-unit=" 일" name="dueDay" value="${a.dueDay ? a.dueDay + ' 일' : ''}" placeholder="넣으면 그날 알림이 뜹니다">`)}
      ${g.includes('마이너스') ? row('한도', money('limit', a.limit || '')) : ''}` : ''}
    <div class="gap"></div>
    ${/^(현금|은행)$|카드/.test(a.group) ? `<details${a.cur ? ' open' : ''}><summary>외화 자산</summary><p class="cap">환전해 둔 자산이면 화폐와 환전한 환율을 적습니다. 이 자산으로 내역을 적을 때 외화 금액을 넣으면 원화로 계산됩니다.</p>
      ${row('화폐', `<input name="cur" value="${esc(a.cur || '')}" placeholder="예: JPY" maxlength="3">`)}
      ${row('환율', `<input type="number" step="any" inputmode="decimal" name="rate" value="${a.rate || ''}" placeholder="1단위당 원. 예: 9.4">`)}</details>` : ''}
    ${a.group === '체크카드' ? '<p class="cap">체크카드 그룹은 이월, 누적되지 않으며, 누적 금액은 연결된 은행 자산을 통해 살펴볼 수 있습니다. 금액 이월, 누적을 희망하신다면, 자산 그룹을 체크카드가 아닌 은행으로 설정하시면 좋습니다.</p>' : ''}
    <label class="swrow"><span>총액반영 설정</span><input type="checkbox" class="sw" name="inTotal"${a.inTotal ? ' checked' : ''}></label>
    <label class="swrow"><span>이체지출 설정 <small>(켜면 전체통계 누적잔액에서 제외)</small></span><input type="checkbox" class="sw" name="xfer"${a.xfer ? ' checked' : ''}></label>
    <label class="swrow"><span>표시/숨김 설정 <small>(켜면 자산 목록에서 숨김)</small></span><input type="checkbox" class="sw" name="hidden"${a.hidden ? ' checked' : ''}></label>
    <div class="row"><button class="pri">저장하기</button></div>
  </form>`;
}

function saveAsset(v) {
  const name = v.name.trim();
  if (!name) return;
  if (name !== v.orig && S.assets.some(a => a.name === name)) return alert('같은 이름의 자산이 있습니다.');
  const a = S.assets.find(x => x.name === v.orig);
  if (!a) Core.addAsset(S, name, v.group);
  const cur = S.assets.find(x => x.name === (a ? v.orig : name));
  Object.assign(cur, { name, group: v.group, inTotal: !!v.inTotal, hidden: !!v.hidden, xfer: !!v.xfer, memo: (v.memo ?? cur.memo ?? '').trim(), perf: Math.round(toNum(v.perf ?? cur.perf)) || 0, payFrom: v.payFrom ?? cur.payFrom ?? '', settleDay: Math.min(31, Math.round(toNum(v.settleDay ?? cur.settleDay)) || 1), payDay: Math.min(31, Math.round(toNum(v.payDay ?? cur.payDay)) || 1),
    annualFee: Math.round(toNum(v.annualFee ?? cur.annualFee)) || 0, annualMonth: Math.min(12, Math.round(toNum(v.annualMonth ?? cur.annualMonth)) || 0),
    irate: Number(v.irate ?? cur.irate) || 0, startDate: v.startDate ?? cur.startDate ?? '', endDate: v.endDate ?? cur.endDate ?? '', monthly: Math.round(toNum(v.monthly ?? cur.monthly)) || 0,
    dueDay: Math.min(31, Math.round(toNum(v.dueDay ?? cur.dueDay)) || 0), goal: Math.round(toNum(v.goal ?? cur.goal)) || 0, limit: Math.round(toNum(v.limit ?? cur.limit)) || 0, rtSince: cur.rtSince || today(),
    cur: (v.cur ?? cur.cur ?? '').trim().toUpperCase(), rate: Number(v.rate ?? cur.rate) || 0 });
  if (a && name !== v.orig) {
    for (const t of [...S.tx, ...S.favs, ...S.repeats.map(r => r.tpl)]) { // 이름을 바꾸면 내역의 자산 이름도 같이 바꾼다
      if (t.asset === v.orig) t.asset = name;
      if (t.type === '이체' && t.cat === v.orig) t.cat = name;
    }
    for (const pg of V.stack) if (pg.name === v.orig) pg.name = name;
  }
  if (v.bal != null && v.bal !== '') { // 금액을 직접 고치면 차액을 내역으로 남긴다
    const diff = Math.round(toNum(v.bal)) - (Core.balances(S)[name] || 0);
    if (diff) { S.tx.push({ id: S.seq++, ts: nowTs(), asset: name, cat: '잔액수정', sub: '', note: '잔액 수정', amt: Math.abs(diff), type: diff > 0 ? '수입' : '지출', tag: '', memo: '' }); Core.addCat(S, diff > 0 ? '수입' : '지출', '잔액수정'); }
  }
  done();
}

// [가계부앱] 2026-11-23 : 전체통계 (자산 탭 머리줄의 그래프 아이콘). 누적잔액 = 그 달 말까지의 수입 - 지출 누계, 아래는 달마다 수입·지출
function pageTrend(pg) {
  pg.ym ||= today().slice(0, 7);
  const yms = [...Array(6)].map((_, i) => Core.shiftYm(pg.ym, i - 5));
  // 누적잔액 : 삭제한 자산과 "이체지출 설정"을 켠 자산(그리로 옮긴 돈은 쓴 돈으로 봄)을 뺀 나머지 자산의 월말 잔액 합
  const mine = S.assets.filter(a => !a.deleted && !a.xfer), cum = yms.map(m => { const b = Core.balances({ ...S, tx: S.tx.filter(t => t.ts.slice(0, 10) <= Core.monthEnd(m)) }); return mine.reduce((x, a) => x + (b[a.name] || 0), 0); });
  const io_ = yms.map(m => { const x = Core.periodSums(S.tx, m); return [x.income, x.expense]; });
  return `${head('전체통계', monthNav('pmonth', ymLabel(pg.ym)))}<div class="tot"><small>누적잔액</small><b>${num(cum[5])}</b></div>${charts(pg, cum, io_, ['수입', '지출'])}`;
}

// [가계부앱] 2026-11-23 : 반복 선택 화면과 할부 입력 화면. 입력 화면(스택 바로 아래)의 값을 바꾸고 돌아간다
const txBelow = () => V.stack.at(-2);
function pageRepeat() {
  const cur = EVERY[txBelow().t.rep] ? txBelow().t.rep : '';
  return `${head('반복')}<ul class="list">${[['', '없음'], ...Object.entries(EVERY)].map(([k, l]) => `<li data-act="repSet" data-arg="${k}"${k === cur ? ' class="sel"' : ''}><span class="m">${l}</span></li>`).join('')}</ul>`;
}

// 할부 미리보기 문구 : 달마다 낼 돈과 이자 합계
function instPreview(amt, months, irate) {
  if (!(amt > 0 && months > 1)) return '금액과 개월수를 넣으면 달마다 낼 돈과 이자 합계를 계산해 보여 줍니다.';
  const plan = Core.instPlan(amt, months, irate), interest = plan.reduce((x, p) => x + p.interest, 0), pay = p => won(p.principal + p.interest);
  return `원금 ${won(amt)} · 첫 달 ${pay(plan[0])} · 마지막 달 ${pay(plan.at(-1))}<br>이자 합계 ${won(interest)} · 총 납부 ${won(amt + interest)}`;
}

function pageInst() {
  const t = txBelow().t, amt = Math.round(toNum(t.amt)), months = Math.round(Number(t.months)) || '', irate = t.irate ?? '';
  return `${head('할부')}<form data-form="inst" class="form">
    <label class="frow"><span>할부 입력 (개월수)</span><input inputmode="numeric" autocomplete="off" data-unit="개월" name="months" value="${months ? months + '개월' : ''}" placeholder="예: 6개월" required></label>
    <label class="frow"><span>이자 (연 %)</span><input type="number" step="any" inputmode="decimal" min="0" name="irate" value="${esc(irate)}" placeholder="무이자면 비워 두기"></label>
    <p class="cap" id="instPrev">${instPreview(amt, months, Number(irate) || 0)}</p>
    <p class="cap">이자는 그 달 남은 원금 × 연이율 ÷ 12 로 계산합니다. 카드사 계산과 몇 원 차이가 날 수 있습니다.</p>
    <div class="row"><button class="pri">저장</button><button type="button" data-act="repSet" data-arg="">할부 안 함</button></div></form>`;
}

// [가계부앱] 2026-11-23 : 분류 관리(추가·이름 변경·삭제·순서)와 자산설정 화면. 입력 화면 선택판의 연필 버튼과 더보기에서 들어온다
// ponytail: 이름 입력은 브라우저 기본 입력창(prompt)을 쓴다. 이모지 고르기나 색 지정이 필요해지면 전용 화면으로 바꾼다
function pageCats(pg) {
  const list = S.cats[pg.type];
  return `${head(pg.type + '분류', '<button class="ic" data-act="catAdd" aria-label="분류 추가">＋</button>')}
    <label class="swrow flat"><span>소분류 기능</span><input type="checkbox" class="sw" data-change="subOn"${S.subOff ? '' : ' checked'}></label><div class="gapbar"></div>
    <ul class="list alist">${list.map((c, i) => `<li data-cat="${esc(c)}"><button class="ic del" data-act="catDel" data-arg="${i}" aria-label="삭제">−</button><span class="m"><b>${esc(c)}</b></span>
      ${S.subOff ? '' : `<button class="subb" data-act="catSubs" data-arg="${i}">소분류${subsOf(pg.type, c).length ? ' ' + subsOf(pg.type, c).length : ''}</button>`}<button class="ic" data-act="catRen" data-arg="${i}" aria-label="이름 변경">${ICON.pen}</button><span class="grip" aria-label="${esc(c)} 옮기기">≡</span></li>`).join('') || '<p class="empty">분류가 없습니다.</p>'}</ul>`;
}

function pageAssetSet() {
  return `${head('자산설정', `<span class="hic"><button class="ic" data-act="newAsset" aria-label="자산 추가">＋</button><button class="ic" data-act="aMenu" aria-label="메뉴">${ICON.dots}</button></span>`)}${assetMenu(false)}
    ${grouped(a => `<li data-act="assetEdit" data-arg="${esc(a.name)}"${a.hidden ? ' class="off"' : ''}><span class="m"><b>${esc(a.name)}</b></span><span class="chev">›</span></li>`)}`;
}

// ---------- 더보기 ----------
const EVERY = { day: '매일', weekday: '주중', weekend: '주말', week: '매주', '2week': '2주마다', '4week': '4주마다', month: '매월', monthEnd: '월말', '2month': '2개월마다', '3month': '3개월마다', '4month': '4개월마다', '6month': '6개월마다', year: '매년' };
// [가계부앱] 2026-11-23 : 더보기 탭을 원본 구성으로. 첫 화면은 아이콘 격자, 그 아래 설정관리 · 백업/복원 화면으로 나눈다
const menuList = items => `<ul class="list alist">${items.map(([label, act, arg = '', right = '']) => `<li data-act="${act}" data-arg="${arg}"><span class="m"><b>${label}</b></span>${right ? `<span class="a out">${right}</span>` : ''}</li>`).join('')}</ul>`;
const viewMore = () => `<header><b>설정</b></header>
  <p class="cap pad">내역 ${num(S.tx.length)}건 · 자산 ${S.assets.filter(a => !a.deleted).length}개. 데이터는 이 기기에만 저장됩니다.</p>
  <div class="mgrid">${[['setMgmt', '설정관리', ICON.gear], ['backup', '백업/복원', ICON.undo], ['routines', '루틴 · 할 일', ICON.todo], ['budgetSet', '예산 설정', ICON.budget], ['repeats', '반복 내역', ICON.rep], ['feedback', '피드백', ICON.chat]].map(([k, l, ic]) => `<button data-act="go" data-arg="${k}">${ic}<span>${l}</span></button>`).join('')}</div>`;
// [가계부앱] 2026-11-23 : 피드백. 고른 달의 내역을 규칙으로 따져 예산 속도·초과 분류·평소 대비·잦은 소액·저축·목표·카드 실적을 문장으로 알려 준다
// ponytail: 기준 숫자(저축률 10%·30%, 평소의 1.5배, 3만 원 차이)는 코드에 박아 뒀다. 사람마다 바꾸고 싶어지면 설정으로 뺀다
function pageFeedback(pg) {
  pg.ym ||= today().slice(0, 7);
  const ym = pg.ym, t = today(), cur = ym === t.slice(0, 7), N = Number(Core.monthEnd(ym).slice(8)), d = cur ? Number(t.slice(8)) : N, past = ym < t.slice(0, 7);
  const list = S.tx.filter(x => x.ts.startsWith(ym)), sums = Core.periodSums(S.tx, ym), exp = list.filter(x => x.type === '지출'), bal = Core.balances(S);
  const out = [], add = (lvl, title, text) => out.push(`<li class="fb ${lvl}"><b>${title}</b><p>${text}</p></li>`), man = v => (Math.abs(v) >= 10000 ? (Math.round(v / 1000) / 10).toLocaleString('ko-KR') + '만 원' : won(v));
  if (!list.length) return `${head('피드백', monthNav('pmonth', ymLabel(ym)))}<p class="empty">이 달에는 내역이 없습니다.</p>`;

  // 1. 총평
  const left = sums.income - sums.expense;
  add(left >= 0 ? 'good' : 'bad', '이번 달 흐름', `수입 ${man(sums.income)}, 지출 ${man(sums.expense)}. ${left >= 0 ? `${man(left)} 남았습니다.` : `수입보다 ${man(-left)} 더 썼습니다.`}`);

  // 2. 예산 속도
  const rows = Core.budgetRows(S, ym), tot = rows[0];
  if (tot.budget > 0) {
    const proj = Math.round(tot.spent / d * N), big = [...exp].sort((x, y) => y.amt - x.amt)[0];
    const bigNote = big && big.amt >= tot.spent * 0.3 ? ` 가장 큰 지출은 "${esc(big.note || big.cat)}" ${man(big.amt)}으로 전체의 ${Math.round(big.amt / tot.spent * 100)}%입니다.` : '';
    if (tot.spent > tot.budget) add('bad', '예산 초과', `전체 예산 ${man(tot.budget)} 중 ${man(tot.spent)}을 써서 ${man(tot.spent - tot.budget)} 넘었습니다 (${Math.floor(tot.spent / tot.budget * 100)}%).${bigNote}`);
    else if (cur && proj > tot.budget) add('warn', '예산 속도가 빠릅니다', `${d}일 동안 ${man(tot.spent)}을 썼습니다. 이 속도면 월말에 약 ${man(proj)}이 되어 예산을 ${man(proj - tot.budget)} 넘습니다. 남은 ${N - d}일 동안 하루 ${man(Math.max(0, Math.floor((tot.budget - tot.spent) / Math.max(1, N - d))))} 안으로 쓰면 맞출 수 있습니다.${bigNote}`);
    else add('good', '예산 안에서 쓰는 중', `전체 예산의 ${Math.floor(tot.spent / tot.budget * 100)}%를 썼습니다.${cur && N > d ? ` 남은 ${N - d}일 동안 하루 ${man(Math.floor((tot.budget - tot.spent) / (N - d)))}씩 쓸 수 있습니다.` : ''}`);
  }

  // 3. 분류별 예산
  const over = rows.slice(1).filter(r => r.budget > 0 && r.spent > r.budget).sort((x, y) => (y.spent - y.budget) - (x.spent - x.budget));
  const near = rows.slice(1).filter(r => r.budget > 0 && r.spent <= r.budget && r.spent >= r.budget * 0.8);
  if (over.length) add('bad', `예산을 넘긴 분류 ${over.length}개`, over.map(r => `${esc(r.cat)} ${Math.floor(r.spent / r.budget * 100)}% (${man(r.spent - r.budget)} 초과)`).join('<br>'));
  if (cur && near.length) add('warn', '예산이 거의 찬 분류', near.map(r => `${esc(r.cat)} ${Math.floor(r.spent / r.budget * 100)}% (${man(r.budget - r.spent)} 남음)`).join('<br>'));
  const cs = Core.catSums(list, '지출'), noBud = cs.filter(([c]) => S.budgets[c] == null).slice(0, 3);
  if (noBud.length && tot.budget > 0) add('info', '예산이 없는 분류에서 쓴 돈', noBud.map(([c, v]) => `${esc(c)} ${man(v)}`).join('<br>') + '<br>자주 쓰는 분류면 예산 설정에서 예산을 넣어 두세요.');

  // 4. 평소(직전 3개월 평균) 대비
  const prev = [1, 2, 3].map(n => Object.fromEntries(Core.catSums(S.tx.filter(x => x.ts.startsWith(Core.shiftYm(ym, -n))), '지출'))), avg = c => prev.reduce((x, m) => x + (m[c] || 0), 0) / 3;
  const scale = cur ? d / N : 1, up = cs.filter(([c, v]) => v >= avg(c) * scale * 1.5 && v - avg(c) * scale >= 30000 && avg(c) > 0), down = Object.keys(prev[0]).filter(c => !cur && avg(c) >= 30000 && (Object.fromEntries(cs)[c] || 0) <= avg(c) * 0.5);
  if (up.length) add('warn', '평소보다 많이 쓴 분류', up.slice(0, 4).map(([c, v]) => `${esc(c)} ${man(v)} (최근 3개월 평균 ${man(avg(c))}${cur ? ', 오늘까지 기준으로 환산해 비교' : ''})`).join('<br>'));
  if (down.length) add('good', '평소보다 줄인 분류', down.slice(0, 4).map(c => `${esc(c)} ${man(Object.fromEntries(cs)[c] || 0)} (평균 ${man(avg(c))})`).join('<br>'));
  if (cs.length) add('info', '많이 쓴 분류', cs.slice(0, 3).map(([c, v]) => `${esc(c)} ${man(v)} (${Math.round(v / sums.expense * 100)}%)`).join('<br>'));

  // 5. 잦은 소액
  const byNote = {}; for (const x of exp) if (x.note && x.amt < 30000) { const o = byNote[x.note] ||= { n: 0, s: 0 }; o.n++; o.s += x.amt; }
  const small = Object.entries(byNote).filter(([, o]) => o.n >= 3).sort((x, y) => y[1].s - x[1].s).slice(0, 3);
  if (small.length) add('info', '잦은 소액 지출', small.map(([k, o]) => `${esc(k)} ${o.n}번, 합계 ${man(o.s)}`).join('<br>'));

  // 6. 저축 : 저축·투자 그룹 자산으로 옮긴 돈 - 거기서 꺼낸 돈
  const sv = name => /저축|투자/.test(S.assets.find(a => a.name === name)?.group || '');
  const saved = list.filter(x => x.type === '이체').reduce((s, x) => s + (sv(x.cat) && !sv(x.asset) ? x.amt : 0) - (sv(x.asset) && !sv(x.cat) ? x.amt : 0), 0);
  if (sums.income > 0) {
    const rate = Math.round(saved / sums.income * 100);
    if (saved <= 0) add('bad', '저축이 없습니다', `이번 달 저축·투자 자산으로 옮긴 돈보다 꺼낸 돈이 ${man(-saved)} 많습니다.`);
    else if (rate < 10) add('warn', '저축을 더 해야 합니다', `저축·투자로 ${man(saved)}을 옮겼습니다. 수입의 ${rate}%입니다. 수입의 10%인 ${man(sums.income * 0.1)}까지 ${man(sums.income * 0.1 - saved)} 더 필요합니다.`);
    else add(rate >= 30 ? 'good' : 'info', `저축률 ${rate}%`, `저축·투자로 ${man(saved)}을 옮겼습니다.${rate >= 30 ? ' 수입의 30%를 넘겼습니다.' : ` 수입의 30%인 ${man(sums.income * 0.3)}까지 ${man(sums.income * 0.3 - saved)} 남았습니다.`}`);
  }

  // 7. 목표 금액
  const goals = S.assets.filter(a => !a.deleted && a.goal > 0);
  if (goals.length) add('info', '목표', goals.map(a => { const b = Math.max(0, bal[a.name] || 0), p = Math.floor(b / a.goal * 100); return `${esc(a.name)} : ${p >= 100 ? '달성' : `${p}% · 목표까지 ${100 - p}% (${man(a.goal - b)}) 남음`}`; }).join('<br>'));

  // 8. 카드 실적
  const cards = S.assets.filter(a => !a.deleted && isCard(a) && a.perf > 0).map(a => [a, perfOf(a, ym)]);
  const short = cards.filter(([a, p]) => p < a.perf);
  if (short.length && !past) add('warn', '카드 실적이 남았습니다', short.map(([a, p]) => `${esc(a.name)} ${Math.floor(p / a.perf * 100)}% · ${man(a.perf - p)} 더 써야 합니다`).join('<br>'));
  else if (cards.length && !short.length) add('good', '카드 실적 충족', cards.map(([a, p]) => `${esc(a.name)} ${man(p)}`).join('<br>'));

  return `${head('피드백', monthNav('pmonth', ymLabel(ym)))}<p class="cap pad">${cur ? `오늘(${d}일)까지의 내역으로 계산했습니다.` : '그 달 전체 내역으로 계산했습니다.'} 평소는 직전 3개월 평균입니다.</p><ul class="fbs">${out.join('')}</ul>`;
}

function pageSetMgmt(pg) {
  const dlg = pg.dlg === 'cardMode' ? `<div class="modal" data-act="setDlg" data-arg=""><div class="dlg glist" data-act="nop"><b>카드지출 반영방법<button type="button" class="ic" data-act="setDlg" data-arg="" aria-label="닫기">✕</button></b>
      <p>카드를 사용하는 시점에 가계부탭에 '지출'로 반영하거나, 카드 사용금액이 아닌 카드 결제대금을 '지출'로 반영하실 수 있습니다.<br><br>A. 카드 사용시점에 지출로 5,000원을 반영<br>B. 카드대금 결제 시, 결제대금 5,000원을 지출로 반영</p>
      <button type="button" class="on" data-act="setDlg" data-arg="">A. 사용시점<i>✓</i></button><button type="button" data-act="cardModeB">B. 결제대금</button></div></div>`
    : pg.dlg === 'sub' ? `<div class="modal" data-act="setDlg" data-arg=""><div class="dlg glist" data-act="nop"><b>소분류 설정<button type="button" class="ic" data-act="setDlg" data-arg="" aria-label="닫기">✕</button></b>
      <p>분류를 한 단계로만 쓰거나, 소분류 기능을 켜서 분류 아래에 소분류를 둘 수 있습니다. 소분류는 수입·지출 분류 관리에서 분류마다 추가합니다.</p>
      ${[['off', 'OFF'], ['on', 'ON']].map(([k, l]) => `<button type="button" data-act="subSet" data-arg="${k}"${(S.subOff ? 'off' : 'on') === k ? ' class="on"' : ''}>${l}${(S.subOff ? 'off' : 'on') === k ? '<i>✓</i>' : ''}</button>`).join('')}</div></div>` : '';
  return `${head('설정관리')}<h3 class="gh">자산관리</h3>${menuList([['자산그룹', 'go', 'groups'], ['자산설정', 'go', 'assetSet'], ['삭제된 자산그룹', 'go', 'gGone'], ['삭제된 자산', 'go', 'aGone'], ['이체지출 설정', 'go', 'xfer'], ['카드지출 반영방법', 'setDlg', 'cardMode', 'A. 사용시점'], ['카드 이용실적', 'go', 'cardPerf']])}
    <h3 class="gh">분류/반복</h3>${menuList([['수입분류 관리', 'cats', '수입'], ['지출분류 관리', 'cats', '지출'], ['소분류 기능', 'setDlg', 'sub', S.subOff ? 'OFF' : 'ON']])}${dlg}`;
}
const pageGGone = () => `${head('삭제된 자산그룹')}<ul class="list alist">${(S.groupsGone || []).map((g, i) => `<li><span class="m"><b>${esc(g)}</b></span><button data-act="gRestore" data-arg="${i}">복원</button></li>`).join('') || '<p class="empty">삭제된 자산그룹이 없습니다.</p>'}</ul>`;
function pageBackup() {
  return `${head('백업/복원')}${menuList([['백업 파일 내보내기', 'exportBackup'], ['백업 파일 불러오기 (전체 교체)', 'pick', 'fb'], ['엑셀 파일 내보내기', 'exportXlsx'], ['엑셀 파일 가져오기 (내역 전체 교체)', 'pick', 'fx']])}
    <input type="file" id="fx" accept=".xlsx" data-change="importXlsx" hidden><input type="file" id="fb" accept=".json,application/json" data-change="importBackup" hidden>
    <p class="cap pad">데이터는 이 기기의 브라우저에만 저장됩니다. 브라우저의 사이트 데이터를 지우면 같이 사라지니 가끔 백업 파일을 내보내 두세요.</p>
    <h3 class="gh">초기화</h3>${menuList([['전체 초기화', 'resetAll'], ['가계부 내역만 초기화', 'resetTx']])}`;
}
// 자산그룹 : 추가(＋) · 이름 변경(연필) · 삭제(−) · 순서(≡ 끌기). 현금·은행·카드·체크카드는 앱이 이름으로 동작을 구분해서 고정이다
// ponytail: 저축·대출·보험·마이너스 통장도 이름으로 칸과 알림을 구분한다. 이 이름을 바꾸면 그 그룹 전용 칸이 사라진다. 이름과 종류를 따로 두려면 그룹에 종류 값을 둔다
const GROUPS_FIXED = ['현금', '은행', '카드', '체크카드'];
function pageGroups() {
  return `${head('자산그룹', '<button class="ic" data-act="gAdd" aria-label="자산그룹 추가">＋</button>')}<p class="cap pad">오른쪽 손잡이(≡)를 끌어 순서를 바꿉니다. 이 순서대로 자산 탭에 나옵니다. 자산이 들어 있는 그룹은 삭제할 수 없습니다.</p>
    <ul class="list alist">${S.groups.map((g, i) => { const fixed = GROUPS_FIXED.includes(g); return `<li data-group="${esc(g)}">${fixed ? `<span class="gic">${ICON.coins}</span>` : `<button class="ic del" data-act="gDel" data-arg="${i}" aria-label="${esc(g)} 삭제">−</button>`}<span class="m"><b>${esc(g)}</b></span>${fixed ? '' : `<button class="ic" data-act="gRen" data-arg="${i}" aria-label="${esc(g)} 이름 변경">${ICON.pen}</button>`}<span class="grip" aria-label="${esc(g)} 옮기기">≡</span></li>`; }).join('')}</ul>`;
}
// 삭제된 자산 : 그룹별 목록. 줄을 누르면 자산정보(머리줄에서 복원), − 는 목록에서 완전히 지우기(내역이 하나도 없는 자산만)
function pageAGone() {
  const gone = S.assets.filter(a => a.deleted);
  return `${head('삭제된 자산')}${[...new Set([...S.groups, ...gone.map(a => a.group)])].map(g => { const items = gone.filter(a => a.group === g); return items.length ? `<h3 class="gh">${esc(g)}</h3><ul class="list alist">${items.map(a => `<li data-act="assetEdit" data-arg="${esc(a.name)}"><button class="ic del" data-act="aPurge" data-arg="${esc(a.name)}" aria-label="${esc(a.name)} 완전히 삭제">−</button><span class="m"><b>${esc(a.name)}</b></span><span class="chev">›</span></li>`).join('')}</ul>` : ''; }).join('') || '<p class="empty">삭제된 자산이 없습니다.</p>'}`;
}
function pageXfer() {
  const live = S.assets.filter(a => !a.deleted && !/^(현금|은행)$|카드/.test(a.group));
  return `${head('이체지출 설정')}<p class="cap pad">선택한 자산은 전체통계의 누적잔액에서 빠집니다. 저축, 투자, 대출, 보험처럼 바로 쓸 수 없는 돈을 고릅니다. 현금, 은행, 카드 그룹은 고를 수 없습니다.</p>
    ${[...new Set(live.map(a => a.group))].map(g => `<h3 class="gh">${esc(g)}</h3><ul class="list alist">${live.filter(a => a.group === g).map(a => `<li data-act="xferTog" data-arg="${esc(a.name)}"${a.xfer ? ' class="sel"' : ''}><span class="m"><b>${esc(a.name)}</b></span>${a.xfer ? '<span class="a">✓</span>' : ''}</li>`).join('')}</ul>`).join('')}`;
}
function pageCardPerf() {
  const cards = S.assets.filter(a => !a.deleted && isCard(a));
  return `${head('카드 이용실적')}<div class="cap pad"><p>신용카드 실적기준(예: 전월, 3개월 평균)과 실적금액(예: 300,000)을 설정합니다.</p>
      <p>1. 카드 실적은 1일에서 말일까지의 금액입니다.<br>2. 할부의 경우, 할부 첫달에 할부 총 금액이 실적으로 합산됩니다.<br>3. 실적제외는 내역 입력 화면의 "카드 실적에서 제외"로 설정할 수 있습니다.</p>
      <p class="warn">※ 카드사에 따라 실적 정책에 차이가 있으므로 이 앱의 카드 실적은 참고용으로만 이용을 부탁드립니다.</p></div>
    <form data-form="cardPerf" class="perff">${cards.map(a => `<div class="prow"><span>${esc(a.name)}</span><select name="b:${esc(a.name)}"><option value="">전월실적</option><option value="avg3"${a.perfBase === 'avg3' ? ' selected' : ''}>3개월 평균</option></select>${money('p:' + esc(a.name), a.perf || '', '0')}</div>`).join('') || '<p class="empty">카드 그룹의 자산이 없습니다.</p>'}
      <div class="row pad"><button class="pri">저장하기</button></div></form>`;
}
const pageRepeats = () => `${head('반복 내역')}<ul class="list">${S.repeats.map(r => `<li><span class="c">${EVERY[r.every]}</span><span class="m"><b>${esc(r.tpl.note || r.tpl.cat)}</b><small>${esc(r.tpl.asset)} · 시작 ${r.start.slice(0, 10)}</small></span><span class="a ${cls(r.tpl.type)}">${won(r.tpl.amt)}</span><button data-act="delRepeat" data-arg="${r.id}">삭제</button></li>`).join('') || '<p class="empty">내역 입력의 "반복/할부"에서 추가합니다.</p>'}</ul>`;

function exportXlsx() {
  const ws = XLSX.utils.aoa_to_sheet(Core.txToRows(S));
  for (let r = 1; r <= S.tx.length; r++) ws[XLSX.utils.encode_cell({ r, c: 0 })].z = 'yyyy-mm-dd hh:mm:ss';
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, '가계부 내역');
  XLSX.writeFile(wb, `my_moneybook_${today()}.xlsx`);
}

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
const PAGES = { tx: pageTx, favs: pageFavs, list: pageList, filter: pageFilter, budgetSet: pageBudgetSet, asset: pageAsset, assetInfo: pageAssetInfo, trend: pageTrend, cats: pageCats, assetSet: pageAssetSet, repeat: pageRepeat, inst: pageInst, day: pageDay, memo: pageMemo, budAdd: pageBudAdd, budCat: pageBudCat, budView: pageBudView, statCat: pageStatCat, routines: pageRoutines, routine: pageRoutine, aHide: pageAHide, aDel: pageADel, aOrder: pageAOrder, setMgmt: pageSetMgmt, backup: pageBackup, groups: pageGroups, aGone: pageAGone, xfer: pageXfer, cardPerf: pageCardPerf, repeats: pageRepeats, gGone: pageGGone, feedback: pageFeedback };
function render() {
  const pg = topPg();
  $('#main').innerHTML = pg ? PAGES[pg.p](pg) : { book: viewBook, stats: viewStats, assets: viewAssets, more: viewMore }[V.tab]();
  for (const b of $('#nav').children) b.classList.toggle('on', b.dataset.arg === V.tab);
  // [가계부앱] 2026-11-23 : 자판 위에 뜨는 크롬 자동 완성 줄(열쇠·카드·주소 아이콘)이 안 뜨게 모든 입력칸의 자동 완성을 끈다
  for (const el of $('#main').querySelectorAll?.('form, input, textarea') || []) if (!el.getAttribute('autocomplete')) el.setAttribute('autocomplete', 'off');
  if (pg?.focus) { ($(`[data-ce="${pg.focus}"]`) || $(`[name="${pg.focus}"]`))?.focus?.(); delete pg.focus; } // 선택판을 닫은 뒤 다음 입력칸으로
}
function done() { save(); if (V.stack.length) history.back(); else render(); }
const lines = s => [...new Set(s.split('\n').map(x => x.trim()).filter(Boolean))];
const txById = id => S.tx.find(t => t.id === Number(id));

const ACT = {
  tab: a => { if (a === 'book' && V.tab === 'book' && !V.stack.length) V.sub = 'day'; V.tab = a; V.stack.length = 0; render(); }, // 가계부 탭에 있을 때 가계부를 한 번 더 누르면 일일로
  sub: a => { V.sub = a; render(); },
  back: () => history.back(),
  go: p => go({ p, ...(p === 'filter' && { tab: '자산' }) }),
  month: a => { V.ym = Core.shiftYm(V.ym, Number(a) * (!topPg() && V.sub === 'month' ? 12 : 1)); V.q = ''; render(); },
  openMonth: ym => { V.openMonth = V.openMonth === ym ? '' : ym; render(); },
  range: a => { const [from, to] = a.split(','); go({ p: 'list', title: `${md(from)} ~ ${md(to)}`, from, to }); },
  dayList: d => go({ p: 'day', d }),
  dayNav: n => { const pg = topPg(); pg.d = Core.dAdd(pg.d, Number(n)); V.ym = pg.d.slice(0, 7); render(); },
  dayMemo: () => { const pg = topPg(); pg.memo = !pg.memo; render(); },
  newMemo: d => go({ p: 'memo', t: { ts: (d || today()) + 'T00:00:00' } }),
  editMemo: id => { const m = S.memos.find(m => m.id === Number(id)); go({ p: 'memo', t: { ...m, ts: (m.date || today()) + 'T00:00:00' } }); },
  memoPin: () => { sync(); const t = topPg().t; t.pin = !t.pin; render(); },
  ptab: a => { const pg = topPg(); pg.tab = a; pg.sel = pg.bsel = null; render(); },
  pmonth: a => { const pg = topPg(); pg.sel = pg.bsel = null; pg.ym = Core.shiftYm(pg.ym, Number(a) * (pg.tab === 'month' || pg.tab === 'year' ? 12 : 1)); render(); },
  budView: c => go({ p: 'budView', cat: c, ym: V.ym }),
  budEdit: c => go({ p: 'budCat', cat: c, y: Number((topPg()?.ym || V.ym).slice(0, 4)) }),
  byear: n => { topPg().y += Number(n); render(); },
  budBase: () => { const c = topPg().cat, v = prompt(`${c} 기본예산 (원)`, S.budgets[c] ?? ''); if (v == null) return;
    // 기본예산은 다음 달부터 적용 : 바꾸기 전에 첫 내역이 있는 달 ~ 이번 달의 예산을 월별 예산으로 굳혀 둔다
    const m = ((S.budgetM ||= {})[c] ||= {}), cur = today().slice(0, 7);
    for (let ym = S.tx.reduce((a, t) => (t.ts < a ? t.ts : a), cur).slice(0, 7); ym <= cur; ym = Core.shiftYm(ym, 1)) m[ym] ??= Core.budgetOf(S, c, ym);
    S.budgets[c] = Math.round(toNum(v)) || 0;
    save(); render();
  },
  // [가계부앱] 2026-11-23 : 이월 켜기(이번 달부터) / 끄기
  budRoll: () => {
    const c = topPg().cat, r = (S.budRoll ||= {});
    if (r[c]) { if (!confirm(`"${budLabel(c)}" 이월을 끌까요? 쌓인 이월 ${won(Core.carryOf(S, c, Core.shiftYm(today().slice(0, 7), 1)))} 은 사라집니다.`)) return; delete r[c]; }
    else r[c] = today().slice(0, 7);
    save(); render();
  },
  budMonth: ym => {
    const c = topPg().cat, m = ((S.budgetM ||= {})[c] ||= {}), v = prompt(`${ymLabel(ym)} 예산 (원)\n비우면 기본예산을 씁니다.`, m[ym] ?? '');
    if (v == null) return;
    if (v.trim() === '') delete m[ym]; else m[ym] = Math.round(toNum(v)) || 0;
    save(); render();
  },
  budDel: () => { const c = topPg().cat; if (confirm(`"${budLabel(c)}" 예산을 지울까요? 내역은 남습니다.`)) { delete S.budgets[c]; delete S.budgetM?.[c]; delete S.budRoll?.[c]; done(); } },
  fClear: () => { for (const s of Object.values(V.filter)) s.clear(); render(); },
  stat: a => { V.statType = a; render(); },
  sNav: a => { const n = Number(a); V.sDay = V.sMode === 'week' ? Core.dAdd(V.sDay, 7 * n) : Core.shiftYm(V.sDay.slice(0, 7), V.sMode === 'year' ? 12 * n : n) + '-01'; render(); },
  statCat: c => { const [from, to] = statPeriod(); go(V.sMode === 'month' ? { p: 'statCat', cat: c, type: V.statType, ym: from.slice(0, 7), color: PAL[Core.catSums(Core.between(S.tx, from, to), V.statType).findIndex(r => r[0] === c) % PAL.length] } : { p: 'list', title: c, from, to, cat: c, type: V.statType }); },
  rtDone: id => {
    const m = /^([pfd]):(.*)$/.exec(id);
    if (m) { const r = assetRoutines().find(r => r.id === id), a = S.assets.find(a => a.name === m[2]); (a.rtDone ||= {})[m[1]] = Core.routineDue(r, today()); }
    else { const r = S.routines.find(r => r.id === Number(id)); r.done = Core.routineDue(r, today()); }
    save(); render();
  },
  rtEdit: id => go({ p: 'routine', r: id ? { ...S.routines.find(r => r.id === Number(id)) } : { every: 'month', day: Number(today().slice(8)) } }),
  rtDel: id => { S.routines = S.routines.filter(r => r.id !== Number(id)); done(); },
  memoPal: () => { sync(); const pg = topPg(); pg.pal = !pg.pal; render(); },
  memoCol: c => { sync(); topPg().t.color = c; render(); },
  barSel: i => { const pg = topPg(); pg.bsel = pg.bsel === Number(i) ? null : Number(i); render(); },
  ptSel: i => { const pg = topPg(); pg.sel = pg.sel === Number(i) ? null : Number(i); render(); },
  statSel: c => { V.statSel = V.statSel === c ? '' : c; render(); },
  newTx: d => { const pg = topPg(); openTx({ ...(d && { ts: d + nowTs().slice(10) }), ...(pg?.p === 'asset' && { asset: pg.name }) }); },
  editTx: id => go({ p: 'tx', t: { ...txById(id) } }),
  copyTx: id => { const pg = topPg(); pg.t = { ...txById(id), id: undefined, ts: nowTs() }; pg.dirty = false; render(); },
  delTx: id => { if (confirm('이 내역을 삭제할까요?')) { S.tx = S.tx.filter(t => t.id !== Number(id)); done(); } },
  favTx: id => { const { id: _, ts, photo, ...f } = txById(id); S.favs.push(f); save(); alert('자주 사용하는 내역에 추가했습니다.'); },
  sheet: k => { sync(); const pg = topPg(); pg.pick = k; pg.tmp = pg.t.ts; pg.calYm = ''; pg.pcat = undefined; render(); },
  pickOk: () => { sync(); const pg = topPg(); pg.dirty ||= pg.t.ts !== pg.tmp; pg.t.ts = pg.tmp; pg.pick = ''; render(); },
  nop: () => {},
  repGo: p => { sync(); topPg().pick = ''; go({ p }); },
  repSet: k => { Object.assign(txBelow().t, { rep: k, months: '', irate: '' }); history.back(); },
  feeTog: () => { sync(); const pg = topPg(); pg.fee = !pg.fee; if (!pg.fee) pg.t.fee = ''; else pg.focus = 'fee'; render(); },
  // 대분류를 누름 : 소분류가 없는 분류면 바로 확정하고 자산으로, 있으면 오른쪽에 소분류를 보여 준다
  pcat: c => { sync(); const pg = topPg(), t = pg.t; if (!c) pg.pcat = undefined; else if (subsOf(t.type, c).length) pg.pcat = c; else { t.cat = c; t.sub = ''; pg.pick = 'asset'; pg.dirty = true; } render(); },
  sheetEdit: () => { sync(); const pg = topPg(); go(pg.pick === 'cat' && pg.t.type !== '이체' ? { p: 'cats', type: pg.t.type } : { p: 'assetSet' }); },
  calNav: a => { sync(); const pg = topPg(); pg.calYm = Core.shiftYm(pg.calYm, Number(a)); render(); },
  // 선택판에서 고른 값 반영. 분류 → 자산 → 내용, 이체는 출금 → 입금 → 내용 순으로 넘어간다
  choose: v => {
    sync();
    const pg = topPg(), t = pg.t, tr = t.type === '이체', k = pg.pick;
    if (k === 'date' || k === 'time') { // 창은 열어 둔다. 고르는 중인 값만 바꾼다
      if (v.startsWith('ap:')) pg.tmp = `${pg.tmp.slice(0, 11)}${String(Number(pg.tmp.slice(11, 13)) % 12 + (v === 'ap:오후' ? 12 : 0)).padStart(2, '0')}${pg.tmp.slice(13)}`;
      else pg.tmp = v === 'now' ? nowTs() : v + pg.tmp.slice(10);
      pg.calYm = pg.tmp.slice(0, 7);
      if (k === 'date') { pg.dirty ||= pg.t.ts !== pg.tmp; t.ts = pg.tmp; pg.pick = ''; } // [가계부앱] 2026-11-23 : 날짜는 고르면 즉시 반영
    } else if (k === 'cat' && !tr) { // 분류 선택판의 오른쪽(소분류)을 누른 경우
      t.cat = pg.pcat; t.sub = v; pg.pcat = undefined; pg.pick = 'asset'; pg.dirty = true;
    }
    else {
      t[k] = v;
      pg.pick = k === 'asset' && tr ? 'cat' : '';
      if (!pg.pick) pg.focus = !tr && isFx(S.assets.find(a => a.name === t.asset)) ? 'famt' : 'note';
      pg.dirty = true;
    }
    render();
  },
  useFav: i => openTx({ ...S.favs[i], ts: nowTs() }),
  delFav: i => { S.favs.splice(i, 1); save(); render(); },
  delMemo: id => { S.memos = S.memos.filter(m => m.id !== Number(id)); done(); },
  delRepeat: id => { if (confirm('이 반복을 멈출까요? 이미 만들어진 내역은 남습니다.')) { S.repeats = S.repeats.filter(r => r.id !== Number(id)); save(); render(); } },
  asset: name => go({ p: 'asset', name, tab: 'day', ym: today().slice(0, 7) }),
  assetInfo: () => go({ p: 'assetInfo', name: topPg().name }),
  assetEdit: name => go({ p: 'assetInfo', name }),
  cats: type => go({ p: 'cats', type }),
  catAdd: () => { const name = (prompt('새 분류 이름') || '').trim(); if (name) { Core.addCat(S, topPg().type, name); save(); render(); } },
  catDel: i => { const list = S.cats[topPg().type]; if (confirm(`"${list[i]}" 분류를 목록에서 뺄까요? 내역은 남습니다.`)) { delete S.budgets[list[i]]; delete S.budgetM?.[list[i]]; delete S.budRoll?.[list[i]]; delete S.subs[list[i]]; list.splice(i, 1); save(); render(); } },
  catRen: i => {
    const type = topPg().type, list = S.cats[type], old = list[i], name = (prompt('분류 이름', old) || '').trim();
    if (!name || name === old) return;
    if (list.includes(name)) return alert('같은 이름의 분류가 있습니다.');
    list[i] = name;
    for (const t of [...S.tx, ...S.favs, ...S.repeats.map(r => r.tpl)]) if (t.type === type && t.cat === old) t.cat = name;
    if (type === '지출' && S.budgets[old] != null) { S.budgets[name] = S.budgets[old]; delete S.budgets[old]; if (S.budgetM?.[old]) { S.budgetM[name] = S.budgetM[old]; delete S.budgetM[old]; } if (S.budRoll?.[old]) { S.budRoll[name] = S.budRoll[old]; delete S.budRoll[old]; } }
    if (S.subs[old]) { S.subs[name] = S.subs[old]; delete S.subs[old]; }
    for (const pg of V.stack) if (pg.p === 'tx' && pg.t.type === type && pg.t.cat === old) pg.t.cat = name;
    save(); render();
  },
  // 소분류 목록을 쉼표로 적어 정한다. 비우면 내역에 쓴 소분류를 모아 쓰는 기본 상태로 돌아간다
  catSubs: i => {
    const type = topPg().type, c = S.cats[type][i], v = prompt(`"${c}" 의 소분류 (쉼표로 구분)`, subsOf(type, c).join(', '));
    if (v == null) return;
    const list = [...new Set(v.split(',').map(x => x.trim()).filter(Boolean))];
    if (list.length) S.subs[c] = list; else delete S.subs[c];
    save(); render();
  },
  newAsset: () => go({ p: 'assetInfo', name: '' }),
  memoTog: name => { V.openMemo.has(name) ? V.openMemo.delete(name) : V.openMemo.add(name); render(); },
  gAdd: () => { const g = (prompt('새 자산그룹 이름') || '').trim(); if (!g) return; if (S.groups.includes(g)) return alert('같은 이름의 그룹이 있습니다.'); S.groups.push(g); save(); render(); },
  gRen: i => {
    const old = S.groups[i], g = (prompt('자산그룹 이름', old) || '').trim();
    if (!g || g === old) return;
    if (S.groups.includes(g)) return alert('같은 이름의 그룹이 있습니다.');
    S.groups[i] = g; for (const a of S.assets) if (a.group === old) a.group = g;
    save(); render();
  },
  gDel: i => { const g = S.groups[i]; if (S.assets.some(a => a.group === g && !a.deleted)) return alert('이 그룹에 자산이 있어 삭제할 수 없습니다. 자산의 그룹을 먼저 바꾸세요.'); if (confirm(`"${g}" 그룹을 삭제할까요? 설정관리의 "삭제된 자산그룹"에서 되살릴 수 있습니다.`)) { S.groups.splice(i, 1); (S.groupsGone ||= []).push(g); save(); render(); } },
  gRestore: i => { const [g] = S.groupsGone.splice(i, 1); if (!S.groups.includes(g)) S.groups.push(g); save(); render(); },
  setDlg: k => { topPg().dlg = k; render(); },
  cardModeB: () => alert('결제대금 기준(B)은 아직 지원하지 않습니다. 카드를 쓴 시점에 지출로 잡는 방식(A)만 됩니다.'),
  subSet: k => { S.subOff = k === 'off'; topPg().dlg = ''; save(); render(); },
  aPurge: name => {
    if (S.tx.some(t => t.asset === name || (t.type === '이체' && t.cat === name))) return alert('이 자산을 쓴 내역이 있어 완전히 지울 수 없습니다. 삭제된 상태로는 합계에 들어가지 않습니다.');
    if (confirm(`"${name}" 자산을 목록에서 완전히 지울까요?`)) { S.assets = S.assets.filter(a => a.name !== name); save(); render(); }
  },
  aRestore: name => { S.assets.find(x => x.name === name).deleted = false; save(); render(); },
  xferTog: name => { const a = S.assets.find(x => x.name === name); a.xfer = !a.xfer; save(); render(); },
  aMenu: () => { V.aMenu = !V.aMenu; render(); },
  aGo: k => { V.aMenu = false; if (k === 'new') ACT.newAsset(); else go({ p: k }); },
  aEye: name => { const a = S.assets.find(x => x.name === name); a.hidden = !a.hidden; save(); render(); },
  aDelete: name => { if (confirm(`"${name}" 자산을 삭제할까요? 내역은 남습니다.`)) { S.assets.find(x => x.name === name).deleted = true; save(); render(); } },
  aChart: () => { const pg = topPg(); pg.chart = !pg.chart; render(); },
  moveAsset: a => { const i = S.assets.findIndex(x => x.name === topPg().name), j = i + Number(a); if (S.assets[j]) { [S.assets[i], S.assets[j]] = [S.assets[j], S.assets[i]]; save(); alert('순서를 바꿨습니다.'); } },
  toggleDel: () => { const a = S.assets.find(x => x.name === topPg().name); a.deleted = !a.deleted; done(); },
  pay: () => { const name = topPg().name, c = Core.card(S, name, today().slice(0, 7)); openTx({ type: '이체', asset: S.assets.find(a => a.name === name).payFrom || liveNames().find(n => n !== name), cat: name, amt: c.due + c.unpaid || '', note: '카드 대금' }); },
  pick: id => $('#' + id).click(),
  resetTx: () => { if (confirm(`내역 ${S.tx.length}건과 반복 설정을 모두 지웁니다. 자산·분류는 남습니다. 계속할까요?`)) { S.tx = []; S.repeats = []; done(); } },
  resetAll: () => { if (confirm('내역·자산·분류·예산·메모를 전부 지웁니다. 되돌릴 수 없습니다. 계속할까요?')) { S = Core.newState(); done(); } },
  exportXlsx, exportBackup,
};
const FORM = {
  tx: saveTx,
  asset: saveAsset,
  memo: v => {
    const t = topPg().t, m = { id: Number(v.id) || S.seq++, date: t.ts.slice(0, 10), title: v.title.trim(), text: v.text.trim(), pin: !!t.pin, ...(t.color && { color: t.color }) }, i = S.memos.findIndex(x => x.id === m.id);
    if (i < 0) S.memos.unshift(m); else S.memos[i] = m;
    done();
  },
  inst: v => { const m = Math.round(toNum(v.months)); if (!(m >= 2)) return alert('개월수는 2 이상으로 넣어 주세요.'); Object.assign(txBelow().t, { rep: 'inst', months: String(m), irate: Number(v.irate) > 0 ? v.irate : '' }); history.back(); },
  routine: v => {
    const list = (S.routines ||= []), old = list.find(r => r.id === Number(v.id));
    const r = { id: old?.id || S.seq++, text: v.text.trim(), every: v.every, since: old?.since || today(), done: old?.done, ...(v.every === 'week' ? { dow: Number(v.dow) } : v.every === 'once' ? { date: v.date } : { day: Math.min(31, Math.max(1, Math.round(toNum(v.day)) || 1)) }) };
    if (old) list[list.indexOf(old)] = r; else list.push(r);
    done();
  },
  budAdd: v => { S.budgets[v.cat] = Math.round(toNum(v.amt)) || 0; done(); },
  cardPerf: v => { for (const [k, x] of Object.entries(v)) { const a = S.assets.find(a => a.name === k.slice(2)); if (!a) continue; if (k[0] === 'p') a.perf = Math.round(toNum(x)) || 0; else a.perfBase = x; } done(); },
};
const CHANGE = {
  subOn: el => { S.subOff = !el.checked; save(); render(); },
  aGroup: el => { topPg().d = Object.fromEntries(new FormData(el.form)); render(); },
  rtEvery: el => { const pg = topPg(); pg.r = { ...pg.r, text: el.form.text.value, every: el.value }; render(); },
  search: el => { V.q = el.value.trim(); render(); },
  // 구분이나 분류를 바꾸면 입력하던 값을 들고 다시 그린다. 구분이 바뀌면 분류는 비운다
  txType: el => { const pg = topPg(); pg.t = { ...formVals(el.form), cat: '', sub: '' }; pg.pick = ''; pg.dirty = true; render(); },
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
// [가계부앱] 2026-11-23 : 내용 칸 이전 입력 추천. 최근 내역의 내용 중 친 글자(초성 포함)가 든 것. datalist 대신 직접 그려서 브라우저 자동완성 막대가 안 뜨게
const CHO = 'ㄱㄲㄴㄷㄸㄹㅁㅂㅃㅅㅆㅇㅈㅉㅊㅋㅌㅍㅎ';
const cho = c => { const n = c.charCodeAt(0) - 0xac00; return n >= 0 && n < 11172 ? CHO[Math.floor(n / 588)] : c; };
const sugMatch = (note, q) => { for (let i = 0; i + q.length <= note.length; i++) if ([...q].every((c, j) => c === note[i + j] || (CHO.includes(c) && cho(note[i + j]) === c))) return true; return false; };
const sugShow = el => {
  const q = ceVal(el).trim(), ul = el.parentElement.querySelector('.sug');
  const list = q ? [...new Set([...S.tx].sort(desc).map(x => x.note).filter(Boolean))].filter(n => n !== q && sugMatch(n, q)).slice(0, 8) : [];
  ul.innerHTML = list.map(n => `<li>${esc(n)}</li>`).join('');
  ul.hidden = !list.length;
};
for (const ev of ['input', 'focusin']) document.addEventListener(ev, e => { if (e.target.dataset && 'sug' in e.target.dataset) sugShow(e.target); });
document.addEventListener('focusout', e => { if (e.target.dataset && 'sug' in e.target.dataset) e.target.parentElement.querySelector('.sug').hidden = true; });
document.addEventListener('pointerdown', e => { // 누르는 순간 반영 (focusout 으로 목록이 먼저 닫히지 않게 기본 동작 막음)
  const li = e.target.closest?.('.sug li'); if (!li) return;
  e.preventDefault();
  const el = li.closest('.frow').querySelector('[data-sug]');
  if (el.dataset.ce) el.textContent = li.textContent; else el.value = li.textContent;
  el.dispatchEvent(new Event('input', { bubbles: true })); // 수정 표시(dirty) 갱신
  li.parentElement.hidden = true;
});
// 편집 가능한 div 에 친 글을 숨은 input 으로 옮기고, 수정 화면이면 저장하기 버튼으로 바꾼다
document.addEventListener('input', e => {
  const el = e.target; if (!el.dataset?.ce) return;
  el.parentElement.querySelector(`input[name="${el.dataset.ce}"]`).value = el.classList.contains('one') ? ceVal(el).replace(/\n/g, ' ') : ceVal(el).replace(/\n$/, '');
  const f = el.closest('form'); if (f?.dataset.form === 'tx' && topPg()?.p === 'tx') { topPg().dirty = true; f.classList.add('dirty'); }
});
// [가계부앱] 2026-11-23 : 내용 칸은 한 줄 textarea. 크롬 자동완성 막대(열쇠·카드·위치)는 input 에만 붙어서. 줄바꿈은 막는다
document.addEventListener('keydown', e => { if (e.key === 'Enter' && e.target.classList?.contains('one')) { e.preventDefault(); if (!e.isComposing) e.target.blur(); } });
document.addEventListener('input', e => { if (e.target.classList?.contains('one') && /\n/.test(e.target.value)) e.target.value = e.target.value.replace(/\n/g, ' '); });
// [가계부앱] 2026-11-23 : 선택판(분류·자산 등)이 열린 채 다른 입력칸을 누르면 선택판을 닫는다. 다시 그리지 않고 지워서 키보드·포커스 유지
document.addEventListener('focusin', e => {
  const pg = topPg(), f = e.target.form;
  if (!pg?.pick || f?.dataset?.form !== 'tx' || !/^(INPUT|TEXTAREA)$/.test(e.target.tagName)) return;
  pg.pick = ''; pg.pcat = undefined;
  document.querySelectorAll('#main .sheet, #main .modal').forEach(x => x.remove());
  f.classList.remove('picking'); f.querySelectorAll('.fld.on').forEach(x => x.classList.remove('on'));
});
document.addEventListener('submit', e => {
  e.preventDefault();
  FORM[e.target.dataset.form](Object.fromEntries(new FormData(e.target, e.submitter)));
});
document.addEventListener('change', e => { const k = e.target.dataset.change; if (k) CHANGE[k](e.target); });
document.addEventListener('input', e => { if ('money' in e.target.dataset) { e.target.value = wonIn(e.target.value); caret(e.target); } });
// [가계부앱] 2026-11-23 : 단위가 붙는 숫자칸. 2 를 치면 "2개월" 로 보이게
document.addEventListener('input', e => { const u = e.target.dataset.unit; if (u) { const d = e.target.value.replace(/\D/g, ''); e.target.value = d && d + u; caret(e.target); } });
// 시간 숫자칸 : 치는 대로 고르는 중인 값과 창 머리줄에 반영(화면은 다시 그리지 않음). 시를 다 치면 분으로 넘어간다
document.addEventListener('input', e => {
  if (!e.target.dataset.tm) return;
  const [hEl, mEl] = e.target.parentElement.querySelectorAll('[data-tm]'), pg = topPg(), digits = el => el.value.replace(/\D/g, '');
  const pm = Number(pg.tmp.slice(11, 13)) >= 12, h = Math.min(12, Number(digits(hEl)) || 12), m = Math.min(59, Number(digits(mEl)) || 0);
  pg.tmp = `${pg.tmp.slice(0, 11)}${String(h % 12 + (pm ? 12 : 0)).padStart(2, '0')}:${String(m).padStart(2, '0')}:00`;
  $('.tmv').textContent = hm(pg.tmp);
  if (e.target === hEl && (digits(hEl).length === 2 || Number(digits(hEl)) > 1)) mEl.focus();
});
// 수정 화면에서 글자를 고치면 바로 저장하기 버튼으로 바꾼다 (화면은 다시 그리지 않음)
document.addEventListener('input', e => { const f = e.target.form; if (f?.dataset?.form === 'tx' && topPg()?.p === 'tx') { topPg().dirty = true; f.classList.add('dirty'); } });
// 할부 화면 : 개월수나 이자를 치는 대로 미리보기를 다시 계산한다 (화면은 다시 그리지 않음)
document.addEventListener('input', e => { const f = e.target.form; if (f?.dataset?.form === 'inst') $('#instPrev').innerHTML = instPreview(Math.round(toNum(txBelow().t.amt)), Math.round(toNum(f.months.value)), Number(f.irate.value) || 0); });
// [가계부앱] 2026-11-23 : 자산 순서 변경. 손잡이를 잡고 끌면 줄이 따라 움직이고, 놓으면 화면에 보이는 순서대로 저장한다
// ponytail: 끌면서 화면 끝에 닿아도 저절로 스크롤되지 않는다. 한 그룹이 화면보다 길어지면 가장자리 자동 스크롤을 넣는다
let drag = null;
document.addEventListener('pointerdown', e => { const h = e.target.closest?.('.grip'); if (!h) return; drag = h.closest('li'); drag.classList.add('drag'); h.setPointerCapture?.(e.pointerId); e.preventDefault(); });
document.addEventListener('pointermove', e => {
  if (!drag) return;
  const over = document.elementFromPoint(e.clientX, e.clientY)?.closest('li');
  if (over && over !== drag && over.parentElement === drag.parentElement) { const r = over.getBoundingClientRect(); over.parentElement.insertBefore(drag, e.clientY < r.top + r.height / 2 ? over : over.nextSibling); }
});
for (const ev of ['pointerup', 'pointercancel']) document.addEventListener(ev, () => {
  if (!drag) return;
  drag.classList.remove('drag'); drag = null;
  const gs = [...document.querySelectorAll('.alist li[data-group]')].map(li => li.dataset.group); // 자산그룹 화면이면 그룹 순서를, 아니면 자산 순서를 저장
  if (gs.length) { S.groups = gs; save(); render(); return; }
  const cs = [...document.querySelectorAll('.alist li[data-cat]')].map(li => li.dataset.cat);
  if (cs.length) { S.cats[topPg().type] = cs; save(); render(); return; }
  const names = [...document.querySelectorAll('.alist li[data-name]')].map(li => li.dataset.name), at = a => { const i = names.indexOf(a.name); return i < 0 ? Infinity : i; };
  S.assets.sort((a, b) => at(a) - at(b)); save();
});
// 자산정보 : 정산일·결제일을 치는 대로 사용기간 안내를 다시 계산한다 (화면은 다시 그리지 않음)
document.addEventListener('input', e => { const f = e.target.form; if (f?.dataset?.form === 'asset' && /Day$/.test(e.target.name)) { const per = cardPeriods(Math.round(toNum(f.settleDay.value)) || 1, Math.round(toNum(f.payDay.value)) || 1); f.querySelectorAll('.pbox b').forEach((b, i) => { b.textContent = per[i]; }); } });
// 외화 금액을 치면 원화 금액 칸을 환율로 계산해 채운다
document.addEventListener('input', e => { if (e.target.name === 'famt' && e.target.dataset.rate) $('input[name="amt"]').value = wonIn(Math.round(Number(e.target.value) * Number(e.target.dataset.rate)) || ''); });
document.addEventListener('focusin', e => { if (e.target.dataset?.tm) e.target.select(); });
for (const ev of ['focusin', 'click']) document.addEventListener(ev, e => { if (e.target.dataset && ('money' in e.target.dataset || e.target.dataset.unit)) caret(e.target); });
addEventListener('popstate', pop);

(async () => {
  S = { ...Core.newState(), ...(await idb('readonly', s => s.get('state'))) };
  if (Core.runRepeats(S, nowTs())) save(); // 앱을 안 연 사이에 돌아온 반복 내역을 채운다
  navigator.storage?.persist?.(); // 브라우저가 저장소를 임의로 비우지 않게 요청
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {}); // 파일로 직접 열면 등록이 안 되는데, 그때는 캐시 없이 쓴다
  render();
})();
