'use strict';
// PurrID – Donation Transparency (browser side).
// Loaded BEFORE app.js. It uses app.js helpers (api, esc, badge, toast, banner, S) only when its functions run,
// so nothing here depends on load order except that app.js hooks into `TR` (see app.js: views, nav, admin tab, after()).
// All money figures shown here come from the server; this file never calculates balances.
const TR = (() => {
  const $ = (s, r = document) => r.querySelector(s);
  const peso = n => { n = Number(n || 0); return (n < 0 ? '-' : '') + '₱' + Math.abs(n).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); };
  const day = s => { if (!s) return '—'; const d = new Date(s.length === 10 ? s + 'T00:00:00' : s); return isNaN(d) ? esc(s) : d.toLocaleDateString('en-PH', { year: 'numeric', month: 'short', day: 'numeric' }); };
  const localToday = () => new Date(Date.now() - new Date().getTimezoneOffset() * 6e4).toISOString().slice(0, 10);
  const CATS = ['Animal food', 'Veterinary consultation', 'Medicines and treatments', 'Vaccination', 'Rescue and transportation', 'Shelter and supplies', 'Other animal welfare expenses'];
  const safe = fn => async (...a) => { try { await fn(...a); } catch (e) { toast(e.message, 'err'); } };
  const qs = o => new URLSearchParams(Object.entries(o).filter(([, v]) => v !== '' && v != null)).toString();
  const opt = (list, sel, blank) => (blank != null ? `<option value="">${blank}</option>` : '') + list.map(o => `<option ${o === sel ? 'selected' : ''}>${esc(o)}</option>`).join('');
  const stack = (heads, row) => { let i = 0; return row.replace(/<td([^>]*)>/g, (m, a) => `<td${a} data-label="${esc(String((heads[i++] || [''])[0]).replace(/<[^>]*>/g, ''))}"><span class="v">`).replace(/<\/td>/g, '</span></td>'); };
  const table = (caption, heads, rows, empty) => rows.length
    ? `<div class="tbl stack"><table><caption class="sr">${esc(caption)}</caption><thead><tr>${heads.map(h => `<th scope="col" ${h[1] ? `class="${h[1]}"` : ''}>${h[0]}</th>`).join('')}</tr></thead><tbody>${rows.map(r => stack(heads, r)).join('')}</tbody></table></div>`
    : `<div class="empty">${empty}</div>`;
  const pager = (k, r) => r.pages > 1 ? `<nav class="pager noprint" aria-label="Pages"><button class="btn ghost sm" data-tr="page" data-k="${k}" data-p="${r.page - 1}" ${r.page <= 1 ? 'disabled' : ''}>← Previous</button><span class="muted">Page ${r.page} of ${r.pages}</span><button class="btn ghost sm" data-tr="page" data-k="${k}" data-p="${r.page + 1}" ${r.page >= r.pages ? 'disabled' : ''}>Next →</button></nav>` : '';
  const showing = r => r.total ? `Showing ${(r.page - 1) * r.pageSize + 1}–${Math.min(r.page * r.pageSize, r.total)} of ${r.total}` : 'No records';

  const st = { don: { page: 1, status: '', type: '' }, exp: { page: 1, category: '', q: '', from: '', to: '' }, fin: 'overview', adm: { don: { page: 1, status: 'Pending' }, exp: { page: 1 }, audit: { page: 1 } } };
  let sumCache = null;
  const getSummary = () => sumCache || (sumCache = api('/api/transparency/summary').catch(e => { sumCache = null; throw e; }));

  // ------------------------------------------------------------------ shared pieces
  const cards = s => `<div class="fin-stats">
    <div class="stat"><b>${peso(s.donationsReceived)}</b>Verified donations received<small>${s.donationCount} ${s.donationCount === 1 ? 'transaction' : 'transactions'}</small></div>
    <div class="stat"><b>${peso(s.expensesTotal)}</b>Total expenses recorded<small>${s.expenseCount} ${s.expenseCount === 1 ? 'expense' : 'expenses'}</small></div>
    <div class="stat bal"><b>${peso(s.remainingBalance)}</b>Remaining donation balance<small>Verified donations − expenses</small></div></div>`;
  const bars = s => s.categories.length ? `<div class="bars">${s.categories.map(c => `<div class="bar-row"><div class="top"><span>${esc(c.category)}</span><span>${peso(c.amount)} · ${c.percent}%</span></div><div class="bar" role="img" aria-label="${esc(c.category)}: ${c.percent}% of expenses"><i style="width:${Math.max(c.percent, 2)}%"></i></div><span class="muted">${c.count} ${c.count === 1 ? 'expense' : 'expenses'}</span></div>`).join('')}</div>` : '<div class="empty">No expenses have been recorded yet.</div>';
  const proof = e => e.receiptState === 'public' ? e.receipts.map((r, i) => `<a href="/api/transparency/receipts/${r.id}" target="_blank" rel="noopener"><u>Receipt${e.receipts.length > 1 ? ' ' + (i + 1) : ''}</u></a>`).join('<br>') : e.receiptState === 'withheld' ? '<span class="muted">On file (not public)</span>' : '<span class="muted">No receipt yet</span>';
  const noteBox = s => `<p class="muted">Remaining balance = verified cash and GCash donations − recorded expenses. Pending, rejected and cancelled donations are <b>not</b> counted${s.pendingCount ? ` (${s.pendingCount} pending worth ${peso(s.pendingAmount)} awaiting verification)` : ''}. In-kind gifts${s.inKindCount ? ` (${s.inKindCount} verified)` : ''} are listed but not counted as cash. Figures are calculated live from the records · as of ${day(s.asOf)}.</p>`;

  // ------------------------------------------------------------------ PUBLIC PAGE
  function view() {
    return `${banner('Donation transparency', [['Home', '#/'], ['Donation transparency']])}<div class="wrap">
    <p class="lead" style="max-width:70ch">Every peso donated to help Barangay Tinurik's strays is recorded here — what came in, what was spent, and what is left. Only donations that the administrators have <b>verified</b> are counted.</p>
    <section aria-labelledby="t-sum"><h2 id="t-sum" class="sr">Financial summary</h2><div id="tr-summary" aria-live="polite"></div></section>
    <div class="fin-cols sec" style="margin-top:36px"><section class="panel" aria-labelledby="t-cat"><h2 id="t-cat" style="font-size:1.4rem">Where the money goes</h2><div id="tr-cats" aria-live="polite"></div></section>
    <section class="panel" aria-labelledby="t-upd"><h2 id="t-upd" style="font-size:1.4rem">Latest updates</h2><div id="tr-updates" aria-live="polite"></div></section></div>
    <section class="sec" aria-labelledby="t-don"><h2 id="t-don">Donation history</h2><p class="muted">Donor names stay private unless the donor chose to show them. Emails, phone numbers and payment details are never shown.</p>
    <form class="fbar" data-trfilter="don"><div><label for="fd-s">Status</label><select id="fd-s" name="status">${opt(['Verified', 'Pending'], '', 'All')}</select></div><div><label for="fd-t">Type</label><select id="fd-t" name="type">${opt(['Cash', 'GCash', 'In-Kind'], '', 'All')}</select></div></form>
    <div id="tr-don" aria-live="polite"></div></section>
    <section class="sec" aria-labelledby="t-exp"><h2 id="t-exp">Expense history</h2><p class="muted">Each expense shows its category and, when it is safe to share, the receipt.</p>
    <form class="fbar" data-trfilter="exp"><div><label for="fe-c">Category</label><select id="fe-c" name="category">${opt(CATS, '', 'All categories')}</select></div><div><label for="fe-q">Search</label><input id="fe-q" name="q" placeholder="Vaccine, food, animal…"></div><div><label for="fe-f">From</label><input id="fe-f" type="date" name="from"></div><div><label for="fe-t">To</label><input id="fe-t" type="date" name="to"></div></form>
    <div id="tr-exp" aria-live="polite"></div></section></div>`;
  }
  const RENDER = {
    async summary() {
      const s = await getSummary(), empty = !s.donationCount && !s.expenseCount;
      return `${cards(s)}${s.overspent ? '<p class="warn">Recorded expenses are currently higher than verified donations.</p>' : ''}${empty ? '<div class="empty">No verified donations or expenses have been recorded yet. Figures appear here as soon as the administrators verify the first donation.</div>' : ''}${noteBox(s)}`;
    },
    async cats() { return bars(await getSummary()); },
    async updates() {
      const { updates, recent } = await api('/api/transparency/updates');
      if (!updates.length && !recent.length) return '<div class="empty">No updates yet.</div>';
      return `${updates.map(u => `<article style="margin-bottom:16px"><h3 style="margin:0">${esc(u.title)}</h3><span class="muted">${day(u.date)}</span><p style="margin:.4em 0 0">${esc(u.body)}</p></article>`).join('')}${recent.length ? `<h3 style="font-size:1rem;margin-top:18px">Recent activity</h3><ul class="feed">${recent.map(r => `<li><b>${peso(r.amount)}</b> ${r.kind === 'expense' ? 'spent' : 'received'} · ${esc(r.text)}<br><span class="muted">${day(r.at)}</span></li>`).join('')}</ul>` : ''}`;
    },
    async don() {
      const r = await api('/api/transparency/donations?' + qs({ ...st.don, pageSize: 10 }));
      return `<p class="muted count">${showing(r)}</p>${table('Donation history', [['Date received'], ['Donor'], ['Type'], ['Amount', 'num'], ['Status']], r.rows.map(d => `<tr><td>${day(d.date)}</td><td>${esc(d.donor)}</td><td>${esc(d.type)}</td><td class="num">${peso(d.amount)}${d.type === 'In-Kind' ? '<br><span class="muted">est. value</span>' : ''}</td><td>${badge(d.status)}${d.status === 'Pending' ? '<br><span class="muted">not counted yet</span>' : d.type === 'In-Kind' ? '<br><span class="muted">not counted as cash</span>' : ''}</td></tr>`), 'No donations match yet. Verified donations will be listed here.')}${pager('don', r)}`;
    },
    async exp() {
      const r = await api('/api/transparency/expenses?' + qs({ ...st.exp, pageSize: 10 }));
      return `<p class="muted count">${showing(r)}</p>${table('Expense history', [['Date'], ['Expense'], ['Category'], ['Related to'], ['Amount', 'num'], ['Proof'], ['Recorded by']], r.rows.map(e => `<tr><td>${day(e.date)}</td><td><b>${esc(e.title)}</b>${e.description ? `<br><span class="muted">${esc(e.description)}</span>` : ''}</td><td><span class="ctag">${esc(e.category)}</span></td><td>${e.animal ? `<a href="#/animal/${esc(e.animal.id)}"><u>${esc(e.animal.name || e.animal.id)}</u></a>` : ''}${e.animal && e.project ? '<br>' : ''}${e.project ? esc(e.project) : ''}${!e.animal && !e.project ? '—' : ''}</td><td class="num">${peso(e.amount)}</td><td>${proof(e)}</td><td>${esc(e.recordedBy)}</td></tr>`), 'No expenses match yet.')}${pager('exp', r)}`;
    }
  };
  async function load(k) {
    const box = $('#tr-' + k); if (!box) return;
    box.innerHTML = '<div class="empty" role="status">Loading…</div>';
    try { const h = await RENDER[k](); if ($('#tr-' + k) === box) box.innerHTML = h; }
    catch (e) { box.innerHTML = `<div class="empty"><p>This section could not be loaded (${esc(e.message)}).</p><button class="btn ghost sm" data-tr="retry" data-k="${k}">Try again</button></div>`; }
  }
  function hydrate() { sumCache = null; st.don = { page: 1, status: '', type: '' }; st.exp = { page: 1, category: '', q: '', from: '', to: '' }; ['summary', 'cats', 'updates', 'don', 'exp'].forEach(load); }

  // ------------------------------------------------------------------ ADMIN AREA
  const SUBS = [['overview', 'Overview'], ['donations', 'Donations'], ['expenses', 'Expenses'], ['updates', 'Public updates'], ['reports', 'Reports'], ['audit', 'Audit history']];
  const actionLabel = { status_change: 'Status changed', correction: 'Corrected', create: 'Created', void: 'Voided', upload: 'Receipt uploaded', publish: 'Published', unpublish: 'Unpublished', unpublished: 'Unpublished', published: 'Published', edit: 'Edited', generate: 'Report generated' };
  const diff = (a, b) => { if (!a && !b) return ''; const keys = [...new Set([...Object.keys(a || {}), ...Object.keys(b || {})])]; return keys.filter(k => JSON.stringify((a || {})[k]) !== JSON.stringify((b || {})[k])).map(k => `<b>${esc(k)}</b>: ${a && k in a ? esc(a[k] ?? '—') : '—'} → ${b && k in b ? esc(b[k] ?? '—') : '—'}`).join('<br>'); };
  const auditTbl = rows => table('Audit history', [['When'], ['Who'], ['What'], ['Change'], ['Reason']], rows.map(a => `<tr><td>${day(a.at)}<br><span class="muted">${new Date(a.at).toLocaleTimeString('en-PH', { hour: '2-digit', minute: '2-digit' })}</span></td><td>${esc(a.admin || '—')}</td><td>${esc(a.entity)}${a.entityId ? ' #' + a.entityId : ''}<br><span class="muted">${esc(actionLabel[a.action] || a.action)}</span></td><td>${diff(a.oldValues, a.newValues) || '—'}</td><td>${esc(a.reason || '—')}</td></tr>`), 'No financial changes have been recorded yet.');
  const subTabs = () => `<div class="subtabs noprint" role="group" aria-label="Donations and funds sections">${SUBS.map(s => `<button data-tr="sub" data-k="${s[0]}" class="${s[0] === st.fin ? 'on' : ''}">${s[1]}</button>`).join('')}</div>`;
  async function adminHtml() { return `${subTabs()}<div id="fin" aria-live="polite">${await finBody()}</div>`; }
  async function refreshFin() {
    document.querySelectorAll('.subtabs button').forEach(b => b.classList.toggle('on', b.dataset.k === st.fin));
    const box = $('#fin'); if (!box) return;
    try { box.innerHTML = await finBody(); } catch (e) { box.innerHTML = `<div class="empty">${esc(e.message)}</div>`; }
  }
  const finBody = () => ({ overview: bodyOverview, donations: bodyDonations, expenses: bodyExpenses, updates: bodyUpdates, reports: bodyReports, audit: bodyAudit })[st.fin]();

  async function bodyOverview() {
    const o = await api('/api/admin/finance/overview');
    return `${cards(o)}${o.overspent ? '<p class="warn">Recorded expenses are higher than verified donations.</p>' : ''}${o.pendingCount ? `<p class="warn">${o.pendingCount} cash/GCash ${o.pendingCount === 1 ? 'donation' : 'donations'} (${peso(o.pendingAmount)}) ${o.pendingCount === 1 ? 'is' : 'are'} waiting for verification and not yet counted. <button class="btn sm" data-tr="goPending">Review donations</button></p>` : ''}${noteBox(o)}
    <div class="fin-cols"><section class="panel"><h3>Spending by category</h3>${bars(o)}</section><section class="panel"><h3>Latest changes</h3>${o.recentAudit.length ? `<ul class="feed">${o.recentAudit.slice(0, 6).map(a => `<li>${esc(actionLabel[a.action] || a.action)} · ${esc(a.entity)}${a.entityId ? ' #' + a.entityId : ''}<br><span class="muted">${day(a.at)} · ${esc(a.admin || '')}${a.reason ? ' · ' + esc(a.reason) : ''}</span></li>`).join('')}</ul>` : '<div class="empty">Nothing yet.</div>'}</section></div>`;
  }
  async function bodyDonations() {
    const a = st.adm.don, r = await api('/api/admin/finance/donations?' + qs({ status: a.status, page: a.page, pageSize: 15 }));
    return `<div class="fbar noprint"><div><label for="ad-s">Show</label><select id="ad-s" data-trc="admDonStatus">${['', 'Pending', 'Verified', 'Rejected', 'Cancelled'].map(v => `<option value="${v}" ${v === a.status ? 'selected' : ''}>${v || 'All donations'}</option>`).join('')}</select></div></div><p class="muted count">${showing(r)} · Only <b>Verified Cash/GCash</b> donations count toward the balance.</p>
    ${table('Donation records', [['#'], ['Date'], ['Donor (private)'], ['Type'], ['Amount', 'num'], ['Status'], ['Actions']], r.rows.map(d => `<tr><td>${d.id}</td><td>${day(d.date)}</td><td>${esc(d.donor)}<br><span class="muted">${esc(d.email)}</span>${d.showName ? '<br><span class="muted">shows name publicly</span>' : ''}</td><td>${esc(d.type)}</td><td class="num">${peso(d.amount)}</td><td>${badge(d.status)}${d.verifiedBy ? `<br><span class="muted">by ${esc(d.verifiedBy)}</span>` : ''}</td><td style="white-space:nowrap" data-d="${esc(JSON.stringify(d))}">${d.status === 'Pending' ? '<button class="btn sm teal" data-tr="donVerify">Verify</button> <button class="btn sm red" data-tr="donStatus" data-to="Rejected">Reject</button> ' : '<button class="btn sm ghost" data-tr="donStatus">Change status</button> '}<button class="btn sm ghost" data-tr="donCorrect">Correct</button></td></tr>`), 'No donation records match.')}${pager('adon', r)}`;
  }
  async function bodyExpenses() {
    const r = await api('/api/admin/finance/expenses?' + qs({ page: st.adm.exp.page, pageSize: 15 }));
    const form = `<form class="box wide" data-trf="expAdd" style="margin-bottom:24px"><h3>Record an expense</h3>
      <div class="row"><div><label for="x-d">Date of expense</label><input id="x-d" type="date" name="date" value="${localToday()}" max="${localToday()}" required></div><div><label for="x-a">Amount (₱)</label><input id="x-a" type="number" name="amount" min="0.01" step="0.01" required></div></div>
      <div class="row"><div><label for="x-t">Title</label><input id="x-t" name="title" maxlength="120" required placeholder="e.g. Dog food 25 kg"></div><div><label for="x-c">Category</label><select id="x-c" name="category">${opt(CATS)}</select></div></div>
      <label for="x-n">Description (optional — shown publicly, keep it free of private details)</label><input id="x-n" name="description" maxlength="500"><div class="row"><div><label for="x-an">Related Animal ID (optional)</label><input id="x-an" name="animalId" placeholder="PUR-…"></div><div><label for="x-p">Rescue / project (optional)</label><input id="x-p" name="project" maxlength="80"></div></div>
      <label for="x-f">Receipt or proof (JPG, PNG, WEBP or PDF, max 2 MB)</label><input id="x-f" type="file" accept="image/jpeg,image/png,image/webp,application/pdf">
      <label class="chk"><input type="checkbox" name="isPublic"> Show this receipt to the public</label><label class="chk"><input type="checkbox" name="confirmRedacted"> I checked the receipt and removed or covered private details (names, phone numbers, account or card numbers, addresses).</label>
      <p style="margin-top:14px"><button class="btn">Record expense</button></p></form>`;
    return `${form}<p class="muted count">${showing(r)}</p>${table('Expense records', [['#'], ['Date'], ['Expense'], ['Amount', 'num'], ['Related'], ['Receipts'], ['Status'], ['Actions']], r.rows.map(e => `<tr${e.status === 'Voided' ? ' style="opacity:.6"' : ''}><td>${e.id}</td><td>${day(e.date)}</td><td><b>${esc(e.title)}</b><br><span class="ctag">${esc(e.category)}</span>${e.description ? `<br><span class="muted">${esc(e.description)}</span>` : ''}<br><span class="muted">by ${esc(e.recordedBy || '—')}</span></td><td class="num">${peso(e.amount)}</td><td>${e.animalId ? esc(e.animalName || e.animalId) : ''}${e.project ? '<br>' + esc(e.project) : ''}${!e.animalId && !e.project ? '—' : ''}</td><td>${e.receipts.length ? e.receipts.map(x => `<div><button class="btn sm ghost" data-tr="rcView" data-id="${x.id}">View</button> <button class="btn sm ghost" data-tr="rcToggle" data-id="${x.id}" data-pub="${x.isPublic ? 1 : 0}">${x.isPublic ? 'Public · hide' : 'Private · publish'}</button></div>`).join('') : '<span class="muted">None</span>'}</td><td>${badge(e.status)}${e.voidReason ? `<br><span class="muted">${esc(e.voidReason)}</span>` : ''}</td><td style="white-space:nowrap" data-d="${esc(JSON.stringify(e))}">${e.status === 'Active' ? '<button class="btn sm ghost" data-tr="expEdit">Edit</button> <button class="btn sm ghost" data-tr="expReceipt">Add receipt</button> <button class="btn sm red" data-tr="expVoid">Void</button>' : '—'}</td></tr>`), 'No expenses recorded yet. Use the form above to add the first one.')}${pager('aexp', r)}`;
  }
  async function bodyUpdates() {
    const list = await api('/api/admin/finance/updates');
    return `<form class="box wide" data-trf="updAdd" style="margin-bottom:24px"><h3>Publish a transparency update</h3><p class="muted">Short public notes such as "October vaccination drive completed". Do not include private information.</p><label for="u-t">Title</label><input id="u-t" name="title" maxlength="120" required><label for="u-b">Message</label><textarea id="u-b" name="body" rows="3" maxlength="2000" required></textarea><p style="margin-top:14px"><button class="btn">Publish update</button></p></form>
    ${table('Published updates', [['Date'], ['Update'], ['Status'], ['Actions']], list.map(u => `<tr><td>${day(u.createdAt)}</td><td><b>${esc(u.title)}</b><br><span class="muted">${esc(u.body)}</span></td><td>${badge(u.status)}</td><td style="white-space:nowrap" data-d="${esc(JSON.stringify(u))}"><button class="btn sm ghost" data-tr="updEdit">Edit</button> <button class="btn sm ${u.status === 'Published' ? 'red' : 'teal'}" data-tr="updToggle">${u.status === 'Published' ? 'Unpublish' : 'Publish'}</button></td></tr>`), 'No updates yet.')}`;
  }
  const rangePreset = k => {
    const n = new Date(), y = n.getFullYear(), m = n.getMonth(), f = d => new Date(d.getTime() - d.getTimezoneOffset() * 6e4).toISOString().slice(0, 10);
    return k === 'last' ? [f(new Date(y, m - 1, 1)), f(new Date(y, m, 0))] : k === 'year' ? [f(new Date(y, 0, 1)), f(n)] : k === 'all' ? ['2000-01-01', f(n)] : [f(new Date(y, m, 1)), f(n)];
  };
  function bodyReports() {
    const [a, b] = rangePreset('month');
    return `<form class="box wide noprint" data-trf="report" style="margin-bottom:24px"><h3>Financial report</h3><p class="muted">Uses the same calculations as the dashboard. Donor identities are not included.</p><div class="row"><div><label for="r-p">Period</label><select id="r-p" data-trc="preset"><option value="month">This month</option><option value="last">Last month</option><option value="year">This year</option><option value="all">All time</option><option value="custom">Custom dates</option></select></div><div></div></div><div class="row"><div><label for="r-f">From</label><input id="r-f" type="date" name="from" value="${a}" required></div><div><label for="r-t">To</label><input id="r-t" type="date" name="to" value="${b}" required></div></div><label for="r-n">Notes (optional, printed on the report)</label><textarea id="r-n" name="notes" rows="2" maxlength="1000"></textarea>
      <p style="margin-top:14px;display:flex;gap:10px;flex-wrap:wrap"><button class="btn">Preview report</button><button type="button" class="btn ghost" data-tr="csv">Download CSV</button><button type="button" class="btn ghost" data-tr="print">Print / Save as PDF</button></p></form><div id="rep"><div class="empty">Choose a period and press “Preview report”.</div></div>`;
  }
  function reportHtml(r) {
    const tot = (k, v, strong) => `<tr><td>${strong ? '<b>' : ''}${k}${strong ? '</b>' : ''}</td><td class="num">${strong ? '<b>' : ''}${v}${strong ? '</b>' : ''}</td></tr>`;
    return `<article class="box wide"><h2 style="font-size:1.6rem">PurrID financial report</h2><p class="muted">Barangay Tinurik, Tanauan City, Batangas · Period: <b>${day(r.period.from)} – ${day(r.period.to)}</b> · Generated ${day(r.generatedAt)}</p>
    <h3>Summary</h3>${table('Summary', [['Item'], ['Amount', 'num']], [tot('Opening balance', peso(r.openingBalance)), tot('+ Verified cash/GCash donations received (' + r.donations.count + ')', peso(r.donations.total)), tot('− Expenses (' + r.expenses.count + ')', peso(r.expenses.total)), tot('Closing balance', peso(r.closingBalance), true)])}
    <h3 style="margin-top:24px">Expense breakdown by category</h3>${table('Expense breakdown', [['Category'], ['Expenses', 'num'], ['Amount', 'num']], r.categories.map(c => `<tr><td>${esc(c.category)}</td><td class="num">${c.count}</td><td class="num">${peso(c.amount)}</td></tr>`))}
    <h3 style="margin-top:24px">Donations received</h3>${table('Donations', [['Date'], ['Type'], ['Amount', 'num']], r.donations.items.map(d => `<tr><td>${day(d.date)}</td><td>${esc(d.type)}</td><td class="num">${peso(d.amount)}</td></tr>`), 'No verified donations in this period.')}
    <h3 style="margin-top:24px">Expenses and supporting documents</h3>${table('Expenses', [['#'], ['Date'], ['Expense'], ['Category'], ['Amount', 'num'], ['Receipts']], r.expenses.items.map(e => `<tr><td>${e.id}</td><td>${day(e.date)}</td><td>${esc(e.title)}${e.animalId ? `<br><span class="muted">${esc(e.animalId)}</span>` : ''}</td><td>${esc(e.category)}</td><td class="num">${peso(e.amount)}</td><td>${e.receipts ? e.receipts + ' on file' + (e.publicReceipts ? ` (${e.publicReceipts} public)` : '') : 'none'}</td></tr>`), 'No expenses in this period.')}
    <h3 style="margin-top:24px">Not counted in the balance</h3><p>${r.notCounted.pendingDonations} pending cash/GCash ${r.notCounted.pendingDonations === 1 ? 'donation' : 'donations'} (${peso(r.notCounted.pendingAmount)}) awaiting verification · ${r.notCounted.inKindVerifiedItems} verified in-kind ${r.notCounted.inKindVerifiedItems === 1 ? 'item' : 'items'}.</p>${r.notes ? `<h3>Notes</h3><p>${esc(r.notes)}</p>` : ''}</article>`;
  }
  async function bodyAudit() {
    const r = await api('/api/admin/finance/audit?' + qs({ page: st.adm.audit.page, pageSize: 20 }));
    return `<p class="muted">Every financial change is kept here permanently. Entries cannot be edited or deleted.</p><p class="muted count">${showing(r)}</p>${auditTbl(r.rows)}${pager('audit', r)}`;
  }

  // ------------------------------------------------------------------ dialogs + file helpers
  function dialog(title, html, onSubmit, ok = 'Save') {
    const old = $('#trDlg'); if (old) old.remove();
    const d = document.createElement('dialog'); d.id = 'trDlg'; d.setAttribute('aria-label', title);
    d.innerHTML = `<form class="dlg"><h3>${esc(title)}</h3>${html}<div class="dlg-act"><button type="button" class="btn ghost" data-tr="dlgClose">Cancel</button><button class="btn">${esc(ok)}</button></div></form>`;
    document.body.append(d);
    const f = $('form', d);
    f.addEventListener('submit', async ev => { ev.preventDefault(); const b = $('.dlg-act .btn:not(.ghost)', f); b.disabled = true; try { await onSubmit(Object.fromEntries(new FormData(f)), f); d.close(); } catch (e) { toast(e.message, 'err'); } finally { b.disabled = false; } });
    d.addEventListener('close', () => d.remove()); d.showModal();
    const first = $('textarea,input,select', f); if (first) first.focus();
  }
  const reasonField = (label = 'Reason (kept in the audit history)') => `<label>${label}</label><textarea name="reason" rows="2" minlength="5" maxlength="300" required></textarea>`;
  async function prepFile(file) {
    if (!file) return null;
    if (!/^(image\/(jpeg|png|webp)|application\/pdf)$/.test(file.type)) throw new Error('A receipt must be a JPG, PNG, WEBP or PDF file');
    const read = f => new Promise((ok, no) => { const r = new FileReader(); r.onload = () => ok(r.result); r.onerror = () => no(new Error('Could not read the file')); r.readAsDataURL(f); });
    let data = await read(file);
    if (file.type.startsWith('image/') && file.size > 1.2e6) { // shrink big phone photos so they stay under the 2 MB limit
      data = await new Promise((ok, no) => { const i = new Image(); i.onload = () => { const k = Math.min(1, 1800 / Math.max(i.width, i.height)), c = document.createElement('canvas'); c.width = i.width * k; c.height = i.height * k; c.getContext('2d').drawImage(i, 0, 0, c.width, c.height); ok(c.toDataURL('image/jpeg', .85)); }; i.onerror = () => no(new Error('Could not read the image')); i.src = data; });
    }
    if (data.length * 0.75 > 1.95e6) throw new Error('The file is over 2 MB. Please use a smaller file.');
    return { data, name: file.name };
  }
  const checked = v => v === 'on' || v === true;
  async function authBlob(path) { const r = await fetch(path, { headers: S ? { Authorization: 'Bearer ' + S.token } : {} }); if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || 'Could not open the file'); return r; }

  // ------------------------------------------------------------------ click actions
  const ACT = {
    retry: el => el.dataset.k === 'summary' || el.dataset.k === 'cats' ? (sumCache = null, load('summary'), load('cats')) : load(el.dataset.k),
    page(el) { // public lists reload their own section; admin lists reload the finance panel
      const k = el.dataset.k, p = +el.dataset.p;
      if (k === 'don' || k === 'exp') { st[k].page = p; return load(k); }
      st.adm[{ adon: 'don', aexp: 'exp', audit: 'audit' }[k]].page = p; return refreshFin();
    },
    sub(el) { st.fin = el.dataset.k; return refreshFin(); },
    goPending() { st.fin = 'donations'; st.adm.don = { page: 1, status: 'Pending' }; return refreshFin(); },
    dlgClose() { const d = $('#trDlg'); if (d) d.close(); },
    async donVerify(el) { const d = JSON.parse(el.closest('[data-d]').dataset.d); if (!confirm(`Confirm that ${peso(d.amount)} (${d.type}) from ${d.donor} was really received? It will be counted in the public balance.`)) return; const r = await api(`/api/admin/finance/donations/${d.id}/status`, 'PUT', { status: 'Verified' }); toast(r.message, 'ok'); refreshFin(); },
    donStatus(el) {
      const d = JSON.parse(el.closest('[data-d]').dataset.d), to = el.dataset.to;
      dialog(`Donation #${d.id} · ${peso(d.amount)}`, `<label>New status</label><select name="status">${opt(['Pending', 'Verified', 'Rejected', 'Cancelled'].filter(s => s !== d.status), to)}</select>${reasonField()}`, async v => { const r = await api(`/api/admin/finance/donations/${d.id}/status`, 'PUT', v); toast(r.message, 'ok'); refreshFin(); }, 'Update status');
    },
    donCorrect(el) {
      const d = JSON.parse(el.closest('[data-d]').dataset.d);
      dialog(`Correct donation #${d.id}`, `<p class="muted">Use this only to fix a wrong amount, type or date. The old values stay in the audit history.</p><div class="row"><div><label>Amount (₱)</label><input type="number" name="amount" min="0.01" step="0.01" value="${d.amount}" required></div><div><label>Date received</label><input type="date" name="date" value="${d.date}" max="${localToday()}" required></div></div><label>Type</label><select name="type">${opt(['Cash', 'GCash', 'In-Kind'], d.type)}</select>${reasonField()}`, async v => { const r = await api(`/api/admin/finance/donations/${d.id}`, 'PUT', v); toast(r.message, 'ok'); refreshFin(); }, 'Save correction');
    },
    expEdit(el) {
      const e = JSON.parse(el.closest('[data-d]').dataset.d);
      dialog(`Correct expense #${e.id}`, `<p class="muted">The old values stay in the audit history.</p><div class="row"><div><label>Date</label><input type="date" name="date" value="${e.date}" max="${localToday()}" required></div><div><label>Amount (₱)</label><input type="number" name="amount" min="0.01" step="0.01" value="${e.amount}" required></div></div><label>Title</label><input name="title" value="${esc(e.title)}" maxlength="120" required><label>Category</label><select name="category">${opt(CATS, e.category)}</select><label>Description</label><input name="description" value="${esc(e.description || '')}" maxlength="500"><div class="row"><div><label>Animal ID</label><input name="animalId" value="${esc(e.animalId || '')}"></div><div><label>Rescue / project</label><input name="project" value="${esc(e.project || '')}" maxlength="80"></div></div>${reasonField()}`, async v => { const r = await api(`/api/admin/finance/expenses/${e.id}`, 'PUT', v); toast(r.message, 'ok'); refreshFin(); }, 'Save correction');
    },
    expVoid(el) {
      const e = JSON.parse(el.closest('[data-d]').dataset.d);
      dialog(`Void expense #${e.id}`, `<p>${esc(e.title)} · <b>${peso(e.amount)}</b></p><p class="muted">A voided expense is no longer counted and is hidden from the public list. The record is never deleted.</p>${reasonField('Why is this being voided?')}`, async v => { const r = await api(`/api/admin/finance/expenses/${e.id}/void`, 'POST', v); toast(r.message, 'ok'); refreshFin(); }, 'Void expense');
    },
    expReceipt(el) {
      const e = JSON.parse(el.closest('[data-d]').dataset.d);
      dialog(`Add receipt to expense #${e.id}`, `<label>File (JPG, PNG, WEBP or PDF, max 2 MB)</label><input type="file" name="file" accept="image/jpeg,image/png,image/webp,application/pdf" required><label class="chk"><input type="checkbox" name="isPublic"> Show this receipt to the public</label><label class="chk"><input type="checkbox" name="confirmRedacted"> Private details have been removed or covered.</label>`, async (v, f) => { const file = await prepFile($('input[type=file]', f).files[0]); const r = await api(`/api/admin/finance/expenses/${e.id}/receipts`, 'POST', { receipt: { ...file, isPublic: checked(v.isPublic), confirmRedacted: checked(v.confirmRedacted) } }); toast(r.message, 'ok'); refreshFin(); }, 'Upload');
    },
    async rcView(el) { const w = window.open('', '_blank'); try { const r = await authBlob('/api/transparency/receipts/' + el.dataset.id), b = await r.blob(); w.location = URL.createObjectURL(b); } catch (e) { if (w) w.close(); throw e; } },
    rcToggle(el) {
      const id = el.dataset.id, pub = el.dataset.pub === '1';
      if (pub) return api('/api/admin/finance/receipts/' + id, 'PUT', { isPublic: false }).then(r => { toast(r.message, 'ok'); refreshFin(); });
      dialog('Publish this receipt?', '<p class="muted">Anyone will be able to open it. Check that names, phone numbers, account or card numbers and addresses are not visible.</p><label class="chk"><input type="checkbox" name="confirmRedacted" required> Private details have been removed or covered.</label>', async () => { const r = await api('/api/admin/finance/receipts/' + id, 'PUT', { isPublic: true, confirmRedacted: true }); toast(r.message, 'ok'); refreshFin(); }, 'Publish receipt');
    },
    updEdit(el) {
      const u = JSON.parse(el.closest('[data-d]').dataset.d);
      dialog('Edit update', `<label>Title</label><input name="title" value="${esc(u.title)}" maxlength="120" required><label>Message</label><textarea name="body" rows="4" maxlength="2000" required>${esc(u.body)}</textarea>`, async v => { const r = await api('/api/admin/finance/updates/' + u.id, 'PUT', v); toast(r.message, 'ok'); refreshFin(); });
    },
    async updToggle(el) { const u = JSON.parse(el.closest('[data-d]').dataset.d), r = await api('/api/admin/finance/updates/' + u.id, 'PUT', { status: u.status === 'Published' ? 'Unpublished' : 'Published' }); toast(r.message, 'ok'); refreshFin(); },
    async csv() {
      const f = $('form[data-trf=report]'), d = Object.fromEntries(new FormData(f));
      const r = await authBlob('/api/admin/finance/report?' + qs({ from: d.from, to: d.to, notes: d.notes, format: 'csv' })), b = await r.blob(), a = document.createElement('a');
      a.href = URL.createObjectURL(b); a.download = `purrid-financial-report-${d.from}_to_${d.to}.csv`; document.body.append(a); a.click(); a.remove(); toast('Report downloaded', 'ok');
    },
    async print() { if (!$('#rep article')) await FORM.report($('form[data-trf=report]'), Object.fromEntries(new FormData($('form[data-trf=report]')))); window.print(); }
  };
  // ------------------------------------------------------------------ form submits
  const FORM = {
    async expAdd(f, d) {
      const file = await prepFile($('input[type=file]', f).files[0]);
      const r = await api('/api/admin/finance/expenses', 'POST', { date: d.date, title: d.title, category: d.category, amount: d.amount, description: d.description, animalId: d.animalId, project: d.project, receipt: file ? { ...file, isPublic: checked(d.isPublic), confirmRedacted: checked(d.confirmRedacted) } : undefined });
      toast(r.message, 'ok'); if (r.warning) toast(r.warning); refreshFin();
    },
    async updAdd(f, d) { const r = await api('/api/admin/finance/updates', 'POST', d); toast(r.message, 'ok'); refreshFin(); },
    async report(f, d) { const r = await api('/api/admin/finance/report?' + qs({ from: d.from, to: d.to, notes: d.notes })); $('#rep').innerHTML = reportHtml(r); }
  };

  // ------------------------------------------------------------------ event wiring (self-contained; does not touch app.js handlers)
  document.addEventListener('click', safe(async e => { const el = e.target.closest('[data-tr]'); if (el && ACT[el.dataset.tr]) await ACT[el.dataset.tr](el, e); }));
  document.addEventListener('submit', safe(async e => {
    const f = e.target.closest('form[data-trf]'), flt = e.target.closest('form[data-trfilter]');
    if (flt) { e.preventDefault(); return; }
    if (!f) return; e.preventDefault(); const b = $('button:not([type=button])', f); if (b) b.disabled = true;
    try { await FORM[f.dataset.trf](f, Object.fromEntries(new FormData(f))); } finally { if (b) b.disabled = false; }
  }));
  let timer;
  const applyFilter = f => { const k = f.dataset.trfilter, d = Object.fromEntries(new FormData(f)); Object.assign(st[k], d, { page: 1 }); return load(k); };
  document.addEventListener('change', safe(async e => {
    const f = e.target.closest('form[data-trfilter]'); if (f && e.target.type !== 'search' && e.target.name !== 'q') return applyFilter(f);
    if (e.target.dataset.trc === 'admDonStatus') { st.adm.don = { page: 1, status: e.target.value }; return refreshFin(); }
    if (e.target.dataset.trc === 'preset' && e.target.value !== 'custom') { const [a, b] = rangePreset(e.target.value); $('#r-f').value = a; $('#r-t').value = b; }
  }));
  document.addEventListener('input', e => { const f = e.target.closest('form[data-trfilter]'); if (f && e.target.name === 'q') { clearTimeout(timer); timer = setTimeout(safe(() => applyFilter(f)), 350); } });

  return { view, hydrate, adminHtml };
})();
