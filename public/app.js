'use strict';
const $ = (s, r = document) => r.querySelector(s), app = $('#app');
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
let receipt = null, qrText = null;
let S = JSON.parse(localStorage.getItem('purrid') || 'null'), adminTab = 'reports', photoData = null;
const setS = v => { S = v; v ? localStorage.setItem('purrid', JSON.stringify(v)) : localStorage.removeItem('purrid'); };

async function api(path, method = 'GET', body) {
  const res = await fetch(path, { method, headers: { 'Content-Type': 'application/json', ...(S ? { Authorization: 'Bearer ' + S.token } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const d = await res.json().catch(() => ({}));
  if (!res.ok) { if (res.status === 401 && S) { setS(null); nav(); location.hash = '#/login'; } throw new Error(d.error || 'Something went wrong'); }
  return d;
}
function toast(m, t = '') { const e = document.createElement('div'); e.className = 'toast ' + t; e.textContent = m; $('#toasts').append(e); setTimeout(() => e.remove(), 4500); }
const slug = s => String(s || '').toLowerCase().replace(/\s+/g, '-');
const badge = s => `<span class="badge b-${slug(s)}">${esc(s)}</span>`;
const svg = (d, f) => `<svg class="ico" viewBox="0 0 24 24" ${f ? 'fill="currentColor"' : 'fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"'} aria-hidden="true">${d}</svg>`;
const I = {
  paw: svg('<ellipse cx="5.5" cy="11" rx="2" ry="2.6"/><ellipse cx="9.5" cy="6.5" rx="2" ry="2.8"/><ellipse cx="14.5" cy="6.5" rx="2" ry="2.8"/><ellipse cx="18.5" cy="11" rx="2" ry="2.6"/><path d="M12 11c-3 0-6 3.2-6 6 0 2 1.6 3 3.2 3 1.2 0 1.8-.5 2.8-.5s1.6.5 2.8.5c1.6 0 3.2-1 3.2-3 0-2.8-3-6-6-6z"/>', 1),
  cat: svg('<path d="M5 9V4l4 3h6l4-3v5c1 1.3 1.500 2.700 1.500 4.200C20.500 17.500 16.800 20 12 20s-8.500-2.500-8.500-6.800C3.500 11.700 4 10.300 5 9z"/><path d="M9 14.500c.9.8 1.800 1.200 3 1.200s2.100-.4 3-1.200M12 13v1.700"/><circle cx="9" cy="11.500" r=".7" fill="currentColor"/><circle cx="15" cy="11.500" r=".7" fill="currentColor"/>'),
  dog: svg('<path d="M8 6C5 5.500 3.500 8 3.500 11.500c0 1.500.5 2.500 1.500 2.500L7.500 12.500V7.500zM16 6c3-.5 4.500 2 4.500 5.500 0 1.500-.5 2.500-1.500 2.500l-2.500-1.500V7.500z"/><path d="M7.500 7.500c1.500-1.500 7.500-1.500 9 0v6.500c0 3-2.500 5.500-4.500 5.500s-4.500-2.500-4.500-5.500z"/><circle cx="9.800" cy="11" r=".7" fill="currentColor"/><circle cx="14.200" cy="11" r=".7" fill="currentColor"/><path d="M10.500 14.500h3l-1.500 1.500z" fill="currentColor"/>'),
  pin: svg('<path d="M12 21s7-6.100 7-11a7 7 0 10-14 0c0 4.900 7 11 7 11z"/><circle cx="12" cy="10" r="2.500"/>'),
  heart: svg('<path d="M12 20s-7.500-4.600-7.500-10A4.300 4.300 0 0112 7.500 4.300 4.300 0 0119.500 10c0 5.400-7.500 10-7.500 10z"/>')
};
const icon = a => a.Species === 'Cat' ? I.cat : a.Species === 'Dog' ? I.dog : I.paw;
const opts = (list, sel, blank) => (blank ? `<option value="">${blank}</option>` : '') + list.map(o => `<option ${o === sel ? 'selected' : ''}>${o}</option>`).join('');
const SPECIES = ['Dog', 'Cat', 'Other'], SEX = ['Male', 'Female', 'Unknown'];
const STATUS = ['Stray', 'Under Rescue', 'Rescued', 'Available for Adoption', 'Pending Adoption', 'Adopted'], RESCUE = ['Reported', 'Under Rescue', 'Rescued'];

const card = a => `<a class="card" href="#/animal/${esc(a.AnimalID)}"><div class="ph" ${a.Photo ? `style="background-image:url(${a.Photo})"` : ''}>${a.Photo ? '' : icon(a)}</div><div class="in"><h3>${esc(a.Name || 'Unnamed')}</h3><span class="muted">${esc([a.Species, a.Breed, a.Sex].filter(Boolean).join(', ') || 'Details not yet recorded')}</span>${badge(a.Status)}${a.latest && a.latest.Location ? `<span class="loc">${I.pin}${esc(a.latest.Location)}</span>` : ''}</div><div class="stub">${esc(a.AnimalID)}</div></a>`;
const tbl = (heads, rows) => rows.length ? `<div class="tbl"><table><thead><tr>${heads.map(h => `<th>${h}</th>`).join('')}</tr></thead><tbody>${rows.join('')}</tbody></table></div>` : '<div class="empty">Nothing here yet.</div>';
const autoTable = rows => rows.length ? tbl(Object.keys(rows[0]), rows.map(r => `<tr>${Object.values(r).map(v => `<td>${esc(v)}</td>`).join('')}</tr>`)) : '<div class="empty">No records.</div>';
const grid = list => list.length ? `<div class="grid">${list.map(card).join('')}</div>` : '<div class="empty">No animals match yet. Clear a filter, or check back after more animals are registered.</div>';

// ---------- navigation
function nav() {
  const t = S && S.type, a = (h, l, c = '') => `<a href="#/${h}" class="${c}">${l}</a>`;
  $('#menu').innerHTML = a('', 'Home') + a('browse', 'Browse Animals') + a('transparency', 'Transparency') +
    (!S ? a('login', 'Log in') + a('register', 'Join', 'cta') : '') +
    (t === 'user' ? a('register-animal', 'Register Animal') + a('donate', 'Donate') : '') +
    (t === 'admin' ? a('admin', 'Admin Panel') : S ? a('dashboard', 'Dashboard') : '') +
    (S ? `<button data-a="logout">Log out (${esc(S.name.split(' ')[0])})</button>` : '');
  const cur = location.hash.split('/')[1] || ''; document.querySelectorAll('#menu a').forEach(x => x.classList.toggle('on', x.getAttribute('href') === '#/' + cur));
}
const guard = (...types) => { if (!S || !types.includes(S.type)) { toast('Please log in to continue', 'err'); location.hash = '#/login'; return false; } return true; };

let rid = 0;
async function router() {
  const my = ++rid, [, name = '', arg = ''] = location.hash.slice(1).split('/');
  nav(); $('#menu').classList.remove('open');
  const views = { '': home, browse, animal, login, register, 'register-animal': registerAnimal, donate, dashboard, admin, transparency: TR.view };
  try { app.innerHTML = '<div class="wrap empty">Loading…</div>'; const html = await (views[name] || home)(decodeURIComponent(arg)); if (my !== rid) return; if (html != null) app.innerHTML = html; }
  catch (e) { if (my !== rid) return; app.innerHTML = `<div class="wrap"><div class="box"><h2>Oops</h2><p>${esc(e.message)}</p><a class="btn" href="#/">Go home</a></div></div>`; }
  window.scrollTo(0, 0); reveal(); after(name, arg);
}
function reveal() { const io = new IntersectionObserver(es => es.forEach(e => { if (e.isIntersecting) { e.target.classList.add('in'); io.unobserve(e.target); } }), { threshold: .1 }); document.querySelectorAll('.reveal').forEach(e => io.observe(e)); }
function after(name, arg) {
  if (name === 'animal' && $('#qr') && window.QRCode) new QRCode($('#qr'), { text: location.origin + '/#/animal/' + decodeURIComponent(arg), width: 150, height: 150 });
  if (name === '' && $('#heroqr') && window.QRCode) new QRCode($('#heroqr'), { text: location.origin + '/#/browse', width: 170, height: 170 });
  if (name === 'register') toggleRole();
  if (name === 'transparency') TR.hydrate();
  if (name === 'donate' && qrText && $('#dqr') && window.QRCode) { new QRCode($('#dqr'), { text: qrText, width: 180, height: 180 }); qrText = null; }
}

// ---------- views
const WALK = [['dog1', 'R', 30, -4], ['cat1', 'L', 36, -14], ['dog2', 'R', 42, -22], ['cat2', 'L', 48, -30]], HERO_WALK = [['cat1', 'R', 34, -9], ['dog1', 'L', 40, -20], ['cat2', 'R', 46, -30], ['dog2', 'L', 28, -3]];
const walkway = list => `<div class="walkway" aria-hidden="true">${list.map(([n, d, t, s]) => `<span class="pix walker p-${n}" style="--dir:walk${d};--t:${t}s;--d:${s}s"></span>`).join('')}</div>`;
const banner = (t, crumbs) => `<section class="banner"><span class="pix idle p-cat1-idle a" aria-hidden="true"></span><span class="pix idle p-dog1-idle b" aria-hidden="true"></span><div class="in"><h1>${t}</h1><nav aria-label="Breadcrumb">${crumbs.map(c => c[1] ? `<a href="${c[1]}">${c[0]}</a>` : `<span>${c[0]}</span>`).join(' &rarr; ')}</nav></div></section>`;
async function home() {
  const [st, all] = await Promise.all([api('/api/public'), api('/api/animals?limit=12')]);
  const avail = all.filter(a => a.Status === 'Available for Adoption'), shown = (avail.length ? avail : all).slice(0, 4);
  const steps = [['Create an account', 'Join as a resident, volunteer or adopter.'], ['Register a stray', 'Each animal gets a unique ID and QR code.'], ['Report sightings', 'Share where it was seen and how it looks, so the barangay can respond.'], ['Search records', 'Find animals by ID, name, breed, color or place.'], ['Donate', 'Support food, medicine and care.'], ['Adopt', 'Ask to adopt an animal that is ready, and get the decision online.']];
  const word = w => `${I.paw}<span>${w}</span>`, strip = ['Register', 'Monitor', 'Rescue', 'Adopt'].map(word).join('');
  return `<section class="hero"><div class="in"><div class="pic"><img src="/img/dog.jpg" alt="A happy Shih Tzu on the grass"><span class="bubble" aria-hidden="true">WOF WOF</span><div class="pic2"><img src="/img/cat2.jpg" alt="A cream cat resting on a rug"></div></div>
  <div><h1>Every stray in Tinurik gets an ID.</h1><p class="lead">Search the animals registered in Barangay Tinurik, Tanauan City. Report a sighting, or ask to adopt one that is ready for a home.</p>
  <form class="hsearch" data-f="herosearch" role="search"><input name="q" aria-label="Search animals" placeholder="Name, breed, color or place"><button class="btn">Search animals</button></form>
  <div class="links"><a href="#/browse">Browse all animals</a><a href="#/register">Create an account</a></div></div></div>${walkway(HERO_WALK)}</section>
  <div class="wrap"><div class="stats"><div class="stat"><b>${st.registered}</b>Registered animals</div><div class="stat"><b>${st.available}</b>Ready for adoption</div><div class="stat"><b>${st.underRescue}</b>Rescue in progress</div><div class="stat"><b>${st.adopted}</b>Adopted</div><div class="stat"><b>${st.reports}</b>Monitoring reports</div></div>
  <div class="center"><p class="eyebrow">Categories</p><h2>Choose a friend to look for</h2><div class="cats"><a class="cat" href="#/browse/Dog"><span><img class="d" src="/img/dog.jpg" alt="" loading="lazy"></span>Dogs</a><a class="cat" href="#/browse/Cat"><span><img class="c" src="/img/cat1.jpg" alt="" loading="lazy"></span>Cats</a><a class="cat" href="#/browse/Other"><span>${I.paw}</span>Others</a></div></div></div>
  <div class="marq" aria-hidden="true"><div>${strip}${strip}${strip}${strip}</div></div>
  <div class="wrap" style="padding-top:20px"><div style="display:flex;justify-content:space-between;align-items:end;gap:16px;flex-wrap:wrap;margin-bottom:22px"><div><p class="eyebrow">${avail.length ? 'Ready for adoption' : 'Just registered'}</p><h2 style="margin:0">${avail.length ? 'Animals waiting for a home' : 'Recently registered animals'}</h2></div><a class="btn ghost" href="#/browse">View all animals</a></div>${grid(shown)}</div>
  <section class="terra sec"><div class="in"><div><p class="eyebrow">Why register</p><h2>Every stray, on record</h2><p>A unique Animal ID and QR code lets the barangay recognise an animal on sight, follow its rescue, and match it with a family. Neighbours can report where it was seen and how it looks.</p><a class="btn tag" href="#/register">Create an account</a></div><div class="photo"><img src="/img/cat1.jpg" alt="A green-eyed tabby cat stretched out on a carpet" loading="lazy"><span class="bubble" aria-hidden="true">MEOW</span></div></div></section>
  <div class="strip"><div class="grp"><img class="thumb" src="/img/cat2.jpg" alt="" loading="lazy"><div><h2>Found a stray?</h2><p>Register it so the barangay can find it, feed it and rehome it.</p></div></div><a class="btn" href="#/register">Start registering</a></div>
  <div class="wrap"><h2 class="sec" style="margin-top:40px">How PurrID works</h2><ol class="steps" style="margin-top:22px">${steps.map(s => `<li class="step"><h3>${s[0]}</h3><p class="muted">${s[1]}</p></li>`).join('')}</ol></div>`;
}
async function browse(q = '') {
  const list = await api('/api/animals' + (q ? '?q=' + encodeURIComponent(q) : ''));
  return `${banner('Browse animals', [['Home', '#/'], ['Browse animals']])}<div class="wrap"><div class="shop">
  <form class="filters" data-f="search" role="search"><label for="fq">Search</label><input id="fq" name="q" value="${esc(q)}" placeholder="ID, name, breed, color, location"><label for="fs">Species</label><select id="fs" name="species">${opts(SPECIES, '', 'Any')}</select><label for="fx">Sex</label><select id="fx" name="sex">${opts(SEX, '', 'Any')}</select><label for="ft">Status</label><select id="ft" name="status">${opts(STATUS, '', 'Any')}</select><button class="btn">Search</button><p class="muted" style="margin-top:14px">Every animal registered in Barangay Tinurik is listed. Log in as an adopter to request one that is ready for adoption.</p></form>
  <div><p class="muted count" id="count" aria-live="polite">${list.length} ${list.length === 1 ? 'animal' : 'animals'}</p><div id="results">${grid(list)}</div></div></div></div>`;
}
async function animal(id) {
  const a = await api('/api/animals/' + encodeURIComponent(id)), t = S && S.type;
  const act = t === 'user' ? `<h3>Report a sighting or condition</h3><form data-f="sighting"><input type="hidden" name="animalId" value="${esc(a.AnimalID)}"><label>Location</label><input name="location" placeholder="Street / purok / landmark"><label>Condition</label><textarea name="condition" rows="2" placeholder="Injured, hungry, healthy…"></textarea><p><button class="btn teal">Submit report</button></p></form>`
    : t === 'adopter' ? (a.Status === 'Available for Adoption' ? `<button class="btn" data-a="adopt" data-id="${esc(a.AnimalID)}">${I.heart} Request to adopt</button>` : `<p class="muted">Not available for adoption right now.</p>`)
    : t === 'admin' ? '<a class="btn ghost" href="#/admin">Manage in Admin Panel</a>' : '<p><a class="btn" href="#/login">Log in</a> or <a href="#/register"><u>create an account</u></a> to take part.</p>';
  return `<div class="wrap"><a href="#/browse" class="muted">← Back</a><div class="profile" style="margin-top:14px"><div><div class="big" ${a.Photo ? `style="background-image:url(${a.Photo})"` : ''}>${a.Photo ? '' : icon(a)}</div><p><span id="qr"></span></p><button class="btn ghost sm noprint" onclick="window.print()">Print ID tag</button></div>
  <div><h1>${esc(a.Name || 'Unnamed animal')}</h1>${badge(a.Status)}<dl style="margin-top:16px"><dt>Animal ID</dt><dd>${esc(a.AnimalID)}</dd><dt>Species</dt><dd>${esc(a.Species || '—')}</dd><dt>Breed</dt><dd>${esc(a.Breed || '—')}</dd><dt>Color</dt><dd>${esc(a.Color || '—')}</dd><dt>Sex</dt><dd>${esc(a.Sex || '—')}</dd><dt>Registered</dt><dd>${esc(a.RegisterDate)}</dd></dl><div class="noprint">${act}</div></div></div>
  <h2 style="margin-top:40px">Monitoring history</h2><div class="tl">${a.monitoring.length ? a.monitoring.map(m => `<div><b>${esc(m.Date)}</b> ${badge(m.RescueStatus)}<br>${m.Location ? I.pin + ' ' + esc(m.Location) + '<br>' : ''}<span class="muted">${esc(m.Condition || '')}</span></div>`).join('') : '<p class="muted">No monitoring reports yet.</p>'}</div></div>`;
}
function login() {
  return `<div class="wrap"><div class="box"><h2>Welcome back</h2><form data-f="login"><div class="seg">${[['user', 'User'], ['adopter', 'Adopter'], ['admin', 'Admin']].map((x, i) => `<label><input type="radio" name="type" value="${x[0]}" ${i ? '' : 'checked'}><span>${x[1]}</span></label>`).join('')}</div><label>Email (admin: credentials)</label><input name="identifier" required><label>Password</label><input type="password" name="password" required><p><button class="btn" style="width:100%">Log in</button></p></form><p class="muted">New here? <a href="#/register"><u>Create an account</u></a></p></div></div>`;
}
function register() {
  return `<div class="wrap"><div class="box"><h2>Join PurrID</h2><form data-f="register"><div class="seg"><label><input type="radio" name="type" value="user" checked><span>User</span></label><label><input type="radio" name="type" value="adopter"><span>Adopter</span></label></div>
  <div class="row"><div><label>First name</label><input name="firstName" required></div><div><label>Last name</label><input name="lastName" required></div></div><label>Email</label><input type="email" name="email" required><div class="row"><div><label>Phone no.</label><input name="phoneNo"></div><div id="roleBox"><label>Role</label><select name="role"><option>Resident</option><option>Volunteer</option></select></div></div><label>Address</label><input name="address" placeholder="Barangay Tinurik, Tanauan City"><label>Password (min. 6)</label><input type="password" name="password" minlength="6" required><p><button class="btn" style="width:100%">Create account</button></p></form></div></div>`;
}
const toggleRole = () => document.querySelectorAll('input[name=type]').forEach(r => r.onchange = () => $('#roleBox').style.display = r.value === 'user' && r.checked ? '' : r.checked ? 'none' : $('#roleBox').style.display);
function registerAnimal() {
  if (!guard('user')) return ''; photoData = null;
  return `<div class="wrap"><div class="box"><h2>Register a stray animal</h2><p class="muted">All details are optional — register what you know. A unique Animal ID and QR code are created automatically.</p><form data-f="animal"><label>Name</label><input name="name"><div class="row"><div><label>Species</label><select name="species">${opts(SPECIES, '', 'Unknown')}</select></div><div><label>Sex</label><select name="sex">${opts(SEX, '', 'Not sure')}</select></div></div><div class="row"><div><label>Breed</label><input name="breed"></div><div><label>Color</label><input name="color"></div></div><label>Photo</label><input type="file" id="photo" accept="image/*"><div id="prev"></div><p><button class="btn" style="width:100%">Register animal</button></p></form></div></div>`;
}
async function donate() {
  if (!guard('user')) return '';
  const h = await api('/api/my/donations'), rc = receipt; receipt = null;
  const donateKey = (crypto.randomUUID && crypto.randomUUID()) || String(Date.now()) + Math.random().toString(16).slice(2); // same key on retry = never recorded twice
  qrText = rc ? `PurrID Donation Receipt | No. ${rc.id} | ${rc.type} | PHP ${Number(rc.amount).toFixed(2)} | ${rc.date} | ${rc.ack} | Donor: ${S.name}` : null;
  const rcHtml = rc ? `<div class="box" style="margin-bottom:24px;text-align:center"><h3>Donation recorded</h3><p class="muted">Receipt #${rc.id} · ${esc(rc.type)} · ₱${Number(rc.amount).toFixed(2)} · ${esc(rc.date)}</p><div id="dqr"></div><p class="muted">Show this QR code to the Barangay Tinurik administrators when handing over your donation.</p><button class="btn ghost sm noprint" onclick="window.print()">Print receipt</button></div>` : '';
  return `<div class="wrap">${rcHtml}<div class="box"><h2>Support our strays</h2><p class="muted">Donations are recorded and acknowledged here. For GCash or cash, hand your donation to the Barangay Tinurik administrators.</p><form data-f="donate"><input type="hidden" name="idempotencyKey" value="${donateKey}"><label>Amount (₱)</label><input type="number" name="amount" min="1" step="0.01" required><label>Donation type</label><select name="donationType">${opts(['Cash', 'GCash', 'In-Kind'])}</select><label class="chk"><input type="checkbox" name="showName"> Show my first name and last initial in the public donor list (otherwise I stay anonymous)</label><p><button class="btn" style="width:100%">Record donation</button></p></form><p class="muted" style="margin-top:14px">Your donation is counted once the administrators verify it. <a href="#/transparency"><u>See how donations are used</u></a>.</p></div>
  <h3 style="margin-top:40px">My donations</h3>${tbl(['#', 'Date', 'Type', 'Amount', 'Acknowledgement', 'Verification'], h.map(d => `<tr><td>${d.DonationID}</td><td>${d.DateDonated}</td><td>${esc(d.DonationType)}</td><td>₱${d.Amount.toFixed(2)}</td><td>${badge(d.Acknowledgement)}</td><td>${badge(d.VerificationStatus)}</td></tr>`))}</div>`;
}
async function dashboard() {
  if (!guard('user', 'adopter')) return '';
  if (S.type === 'admin') { location.hash = '#/admin'; return null; }
  if (S.type === 'adopter') {
    const r = await api('/api/my/adoptions');
    return `<div class="wrap"><h1>Hello, ${esc(S.name)}</h1><h3>My adoption requests</h3>${tbl(['Animal', 'Requested', 'Status', 'Decision date'], r.map(x => `<tr><td><a href="#/animal/${esc(x.AnimalID)}"><u>${esc(x.Name || x.AnimalID)}</u></a></td><td>${x.RequestDate}</td><td>${badge(x.AdoptionStatus)}</td><td>${x.DecisionDate || '—'}</td></tr>`))}<p><a class="btn" href="#/browse">Find an animal</a></p></div>`;
  }
  const [an, mon] = await Promise.all([api('/api/my/animals'), api('/api/my/monitoring')]);
  return `<div class="wrap"><h1>Hello, ${esc(S.name)}</h1><p><a class="btn" href="#/register-animal">+ Register animal</a> &nbsp; <a class="btn ghost" href="#/donate">Donate</a></p><h3>Animals I registered</h3>${grid(an)}<h3 style="margin-top:36px">Monitoring and rescue updates</h3>${tbl(['Date', 'Animal', 'Location', 'Condition', 'Rescue status', 'Animal status'], mon.map(m => `<tr><td>${m.Date}</td><td><a href="#/animal/${esc(m.AnimalID)}"><u>${esc(m.Name || m.AnimalID)}</u></a></td><td>${esc(m.Location || '—')}</td><td>${esc(m.Condition || '—')}</td><td>${badge(m.RescueStatus)}</td><td>${badge(m.AnimalStatus)}</td></tr>`))}</div>`;
}

// ---------- admin
async function admin() {
  if (!guard('admin')) return '';
  const tabs = [['reports', 'Reports'], ['finance', 'Donations & funds'], ['animals', 'Animal records'], ['monitoring', 'Monitoring & rescue'], ['adoptions', 'Adoptions'], ['accounts', 'Accounts']];
  return `<div class="wrap"><h1>Barangay Tinurik Administration</h1><div class="tabs">${tabs.map(t => `<button data-a="tab" data-t="${t[0]}" class="${t[0] === adminTab ? 'on' : ''}">${t[1]}</button>`).join('')}</div><div id="tab">${await adminTabHtml()}</div></div>`;
}
async function refreshTab() { document.querySelectorAll('.tabs button').forEach(b => b.classList.toggle('on', b.dataset.t === adminTab)); $('#tab').innerHTML = await adminTabHtml(); }
async function adminTabHtml() {
  if (adminTab === 'finance') return TR.adminHtml();
  if (adminTab === 'reports') {
    const r = await api('/api/admin/system-reports');
    return `<form class="box wide" data-f="genreport" style="margin-bottom:24px"><h3>Generate a system report</h3><div class="row"><select name="reportType">${opts(['Animals', 'Monitoring', 'Donations', 'Adoptions', 'Full'])}</select><button class="btn">Generate report</button></div></form>` +
      (r.length ? r.map(x => { const p = x.PublicInformation; return `<details class="box wide" style="margin-bottom:12px"><summary><b>Report #${x.ReportID} — ${esc(x.ReportType)}</b> · ${x.ReportDate}</summary><h4>Summary</h4>${tbl(['Item', 'Value'], Object.entries(p.summary || {}).map(([k, v]) => `<tr><td>${esc(k)}</td><td><b>${esc(v)}</b></td></tr>`))}${Object.entries(p.data || {}).map(([k, rows]) => `<h4>${esc(k)} (${rows.length})</h4>${autoTable(rows)}`).join('')}<h4>Public animal information (available for adoption)</h4>${autoTable(p.publicAnimals || [])}<p><button class="btn ghost sm" onclick="window.print()">Print</button> <button class="btn sm red" data-a="delSysReport" data-id="${x.ReportID}">Delete report</button></p></details>`; }).join('') : '<div class="empty">No reports generated yet.</div>');
  }
  if (adminTab === 'animals') {
    const a = await api('/api/animals?limit=200');
    return tbl(['ID', 'Name', 'Species', 'Breed', 'Color', 'Sex', 'Status', ''], a.map(x => `<tr data-id="${esc(x.AnimalID)}"><td><a href="#/animal/${esc(x.AnimalID)}"><u>${esc(x.AnimalID)}</u></a></td><td><input name="name" value="${esc(x.Name)}"></td><td><select name="species">${opts(SPECIES, x.Species, '—')}</select></td><td><input name="breed" value="${esc(x.Breed)}"></td><td><input name="color" value="${esc(x.Color)}"></td><td><select name="sex">${opts(SEX, x.Sex, '—')}</select></td><td><select name="status">${opts(STATUS, x.Status)}</select></td><td style="white-space:nowrap"><button class="btn sm" data-a="saveAnimal">Save</button> <button class="btn sm red" data-a="delAnimal">Delete</button></td></tr>`));
  }
  if (adminTab === 'monitoring') {
    const m = await api('/api/admin/monitoring');
    return tbl(['Date', 'Animal', 'Reporter', 'Location', 'Condition', 'Rescue status', 'Animal status', ''], m.map(x => `<tr><td>${x.Date}</td><td><a href="#/animal/${esc(x.AnimalID)}"><u>${esc(x.Name || x.AnimalID)}</u></a></td><td>${esc(x.Reporter || '—')}</td><td>${esc(x.Location || '—')}</td><td>${esc(x.Condition || '—')}</td><td><select data-a="rescue" data-id="${x.ReportID}">${opts(RESCUE, x.RescueStatus)}</select></td><td>${badge(x.AnimalStatus)}</td><td><button class="btn sm red" data-a="delReport" data-id="${x.ReportID}">Delete</button></td></tr>`));
  }
  if (adminTab === 'adoptions') {
    const d = await api('/api/admin/adoptions');
    return tbl(['#', 'Animal', 'Adopter', 'Contact', 'Requested', 'Status', 'Decision'], d.map(x => `<tr><td>${x.AdoptionID}</td><td><a href="#/animal/${esc(x.AnimalID)}"><u>${esc(x.Name || x.AnimalID)}</u></a></td><td>${esc(x.Adopter)}</td><td>${esc(x.Email)}<br>${esc(x.PhoneNo || '')}</td><td>${x.RequestDate}</td><td>${badge(x.AdoptionStatus)}</td><td>${x.AdoptionStatus === 'Pending' ? `<button class="btn sm teal" data-a="decide" data-id="${x.AdoptionID}" data-d="Approved">Approve</button> <button class="btn sm red" data-a="decide" data-id="${x.AdoptionID}" data-d="Rejected">Reject</button>` : x.DecisionDate}</td></tr>`));
  }
  const c = await api('/api/admin/accounts');
  const row = (t, id, x) => `<tr><td>${esc(x.FirstName + ' ' + x.LastName)}</td><td>${esc(x.Email)}</td><td>${esc(x.PhoneNo || '')}</td><td>${esc(x.Role || 'Adopter')}</td><td>${badge(x.AccountStatus)}</td><td><button class="btn sm ${x.AccountStatus === 'Active' ? 'red' : 'teal'}" data-a="acct" data-t="${t}" data-id="${id}" data-s="${x.AccountStatus === 'Active' ? 'Suspended' : 'Active'}">${x.AccountStatus === 'Active' ? 'Suspend' : 'Activate'}</button></td></tr>`;
  return `<h3>Users</h3>${tbl(['Name', 'Email', 'Phone', 'Role', 'Status', ''], c.users.map(x => row('user', x.UserID, x)))}<h3 style="margin-top:30px">Adopters</h3>${tbl(['Name', 'Email', 'Phone', 'Role', 'Status', ''], c.adopters.map(x => row('adopter', x.AdopterID, x)))}`;
}

// ---------- form + click handlers
const forms = {
  herosearch(f, d) { location.hash = '#/browse' + (d.q ? '/' + encodeURIComponent(d.q) : ''); },
  async search(f, d) { const p = new URLSearchParams(Object.entries(d).filter(([, v]) => v)), r = await api('/api/animals?' + p); $('#results').innerHTML = grid(r); $('#count').textContent = r.length + (r.length === 1 ? ' animal' : ' animals'); },
  async login(f, d) { const r = await api('/api/login', 'POST', d); setS({ token: r.token, type: r.type, id: r.id, name: r.name }); toast('Welcome, ' + r.name, 'ok'); location.hash = r.type === 'admin' ? '#/admin' : '#/dashboard'; nav(); },
  async register(f, d) { const r = await api('/api/register', 'POST', d); toast(r.message, 'ok'); location.hash = '#/login'; },
  async animal(f, d) { const r = await api('/api/animals', 'POST', { ...d, photo: photoData }); toast(r.message, 'ok'); location.hash = '#/animal/' + r.animalId; },
  async sighting(f, d) { const r = await api('/api/monitoring', 'POST', d); toast(r.message, 'ok'); location.hash = '#/'; },
  async donate(f, d) { const r = await api('/api/donations', 'POST', d); toast(r.message, 'ok'); receipt = { id: r.donationId, type: r.donationType, amount: r.amount, date: r.date, ack: r.acknowledgement }; router(); },
  async genreport(f, d) { const r = await api('/api/admin/system-reports', 'POST', d); toast(r.message, 'ok'); refreshTab(); }
};
const actions = {
  logout: async () => { try { await api('/api/logout', 'POST'); } catch {} setS(null); nav(); location.hash = '#/'; toast('Logged out'); },
  adopt: async el => { const r = await api('/api/adoptions', 'POST', { animalId: el.dataset.id }); toast(r.message, 'ok'); location.hash = '#/dashboard'; },
  tab: el => { adminTab = el.dataset.t; refreshTab(); },
  saveAnimal: async el => { const tr = el.closest('tr'), g = n => $(`[name=${n}]`, tr).value; const r = await api('/api/admin/animals/' + tr.dataset.id, 'PUT', { name: g('name'), species: g('species'), breed: g('breed'), color: g('color'), sex: g('sex'), status: g('status') }); toast(r.message, 'ok'); },
  delAnimal: async el => { if (!confirm('Delete this animal record and its monitoring/adoption history?')) return; await api('/api/admin/animals/' + el.closest('tr').dataset.id, 'DELETE'); toast('Animal record deleted', 'ok'); refreshTab(); },
  rescue: async el => { const r = await api('/api/admin/monitoring/' + el.dataset.id, 'PUT', { rescueStatus: el.value }); toast(r.message, 'ok'); refreshTab(); },
  delReport: async el => { if (!confirm('Delete this monitoring report? This cannot be undone.')) return; const r = await api('/api/admin/monitoring/' + el.dataset.id, 'DELETE'); toast(r.message, 'ok'); refreshTab(); },
  delSysReport: async el => { if (!confirm('Delete this generated report? This cannot be undone.')) return; const r = await api('/api/admin/system-reports/' + el.dataset.id, 'DELETE'); toast(r.message, 'ok'); refreshTab(); },
  decide: async el => { const r = await api('/api/admin/adoptions/' + el.dataset.id, 'PUT', { decision: el.dataset.d }); toast(r.message, 'ok'); refreshTab(); },
  acct: async el => { const r = await api(`/api/admin/accounts/${el.dataset.t}/${el.dataset.id}`, 'PUT', { accountStatus: el.dataset.s }); toast(r.message, 'ok'); refreshTab(); }
};
const safe = fn => async (...a) => { try { await fn(...a); } catch (e) { toast(e.message, 'err'); } };
document.addEventListener('submit', safe(async e => { const f = e.target.closest('form[data-f]'); if (!f) return; e.preventDefault(); const b = $('button', f); if (b) b.disabled = true; try { await forms[f.dataset.f](f, Object.fromEntries(new FormData(f))); } finally { if (b) b.disabled = false; } }));
document.addEventListener('click', safe(async e => { const el = e.target.closest('[data-a]'); if (el && el.tagName !== 'SELECT') await actions[el.dataset.a](el); }));
document.addEventListener('change', safe(async e => {
  if (e.target.matches('select[data-a]')) await actions[e.target.dataset.a](e.target);
  if (e.target.id === 'photo' && e.target.files[0]) { photoData = await new Promise(ok => { const r = new FileReader(); r.onload = () => { const i = new Image(); i.onload = () => { const k = Math.min(1, 640 / Math.max(i.width, i.height)), c = document.createElement('canvas'); c.width = i.width * k; c.height = i.height * k; c.getContext('2d').drawImage(i, 0, 0, c.width, c.height); ok(c.toDataURL('image/jpeg', .8)); }; i.src = r.result; }; r.readAsDataURL(e.target.files[0]); }); $('#prev').innerHTML = `<img src="${photoData}" style="max-width:160px;border-radius:14px;margin-top:8px">`; }
}));
$('#burger').onclick = () => { const o = $('#menu').classList.toggle('open'); $('#burger').setAttribute('aria-expanded', o); };
$('#walk').outerHTML = walkway(WALK);
$('#yr').textContent = new Date().getFullYear();
window.addEventListener('hashchange', router);
router().finally(() => setTimeout(() => $('#loader').classList.add('hide'), 400));
