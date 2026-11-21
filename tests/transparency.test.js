'use strict';
// Run:  node tests/transparency.test.js     (uses a throw-away copy of the database; your purrid.db is never touched)
const { spawn } = require('child_process'), fs = require('fs'), os = require('os'), path = require('path'), assert = require('assert');
const root = path.join(__dirname, '..'), PORT = 3900 + Math.floor(Math.random() * 90), BASE = `http://localhost:${PORT}`;
const dbFile = path.join(os.tmpdir(), `purrid-test-${Date.now()}.db`);
if (fs.existsSync(path.join(root, 'purrid.db'))) fs.copyFileSync(path.join(root, 'purrid.db'), dbFile);
let pass = 0; const t = async (name, fn) => { try { await fn(); pass++; console.log('  ok  ', name); } catch (e) { console.log('  FAIL', name, '\n      ', e.message); process.exitCode = 1; } };
const call = async (p, { method = 'GET', token, body } = {}) => { const r = await fetch(BASE + p, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: body ? JSON.stringify(body) : undefined }); const ct = r.headers.get('content-type') || ''; return { status: r.status, headers: r.headers, data: ct.includes('json') ? await r.json() : Buffer.from(await r.arrayBuffer()) }; };
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const today = new Date().toISOString().slice(0, 10);

(async () => {
  const srv = spawn(process.execPath, ['server.js'], { cwd: root, env: { ...process.env, PORT, DB_FILE: dbFile}, stdio: ['ignore', 'pipe', 'pipe'] });
  await new Promise(ok => srv.stdout.on('data', d => String(d).includes('running') && ok()));
  const login = async (type, identifier, password) => (await call('/api/login', { method: 'POST', body: { type, identifier, password } })).data.token;
  try {
    const admin = await login('admin', 'admin', 'admin123');
    const reg = (n, e) => call('/api/register', { method: 'POST', body: { type: 'user', firstName: n, lastName: 'Santos', email: e, password: 'secret12', phoneNo: '09171234567' } });
    await reg('Maria', 'maria@example.com'); await reg('Juan', 'juan@example.com');
    const maria = await login('user', 'maria@example.com', 'secret12'), juan = await login('user', 'juan@example.com', 'secret12');
    const donate = (tok, amount, type, extra = {}) => call('/api/donations', { method: 'POST', token: tok, body: { amount, donationType: type, ...extra } });

    console.log('Donations & verification');
    await t('empty state: all totals are zero', async () => { const s = (await call('/api/transparency/summary')).data; assert.deepStrictEqual([s.donationsReceived, s.expensesTotal, s.remainingBalance, s.donationCount, s.expenseCount], [0, 0, 0, 0, 0]); });
    let d1, d2, d3, d4;
    await t('new donation starts Pending and is NOT counted', async () => { d1 = (await donate(maria, '1000.50', 'GCash', { showName: true, idempotencyKey: 'k1' })).data; assert.strictEqual(d1.verification, 'Pending'); assert.strictEqual((await call('/api/transparency/summary')).data.donationsReceived, 0); });
    await t('double submit with the same key does not duplicate', async () => { const again = (await donate(maria, '1000.50', 'GCash', { showName: true, idempotencyKey: 'k1' })).data; assert.strictEqual(again.donationId, d1.donationId); assert.strictEqual(again.duplicate, true); assert.strictEqual((await call('/api/admin/finance/donations', { token: admin })).data.total, 1); });
    d2 = (await donate(juan, 500, 'Cash')).data; d3 = (await donate(juan, 300, 'Cash')).data; d4 = (await donate(juan, 250, 'In-Kind')).data;
    const status = (id, st, reason, tok = admin) => call(`/api/admin/finance/donations/${id}/status`, { method: 'PUT', token: tok, body: { status: st, reason } });
    await t('users and visitors cannot verify donations', async () => { assert.strictEqual((await status(d1.donationId, 'Verified', '', maria)).status, 401); assert.strictEqual((await status(d1.donationId, 'Verified', '', null)).status, 401); });
    await t('verified cash/GCash counts; pending, rejected, in-kind do not', async () => {
      assert.strictEqual((await status(d1.donationId, 'Verified')).status, 200); assert.strictEqual((await status(d2.donationId, 'Verified')).status, 200);
      assert.strictEqual((await status(d3.donationId, 'Rejected')).status, 400, 'rejecting needs a reason'); assert.strictEqual((await status(d3.donationId, 'Rejected', 'Payment not received')).status, 200);
      assert.strictEqual((await status(d4.donationId, 'Verified')).status, 200);
      const s = (await call('/api/transparency/summary')).data; assert.strictEqual(s.donationsReceived, 1500.5); assert.strictEqual(s.donationCount, 2); assert.strictEqual(s.inKindCount, 1); assert.strictEqual(s.remainingBalance, 1500.5);
    });
    await t('public donation list hides private data and honours anonymity', async () => {
      const r = (await call('/api/transparency/donations')).data, txt = JSON.stringify(r);
      assert.ok(!/maria@|juan@|0917|Santos|UserID|Email|Phone/i.test(txt), 'no PII'); assert.ok(r.rows.some(x => x.donor === 'Maria S.')); assert.ok(r.rows.some(x => x.donor === 'Anonymous donor'));
      assert.ok(!r.rows.some(x => x.status === 'Rejected'), 'rejected hidden');
      assert.strictEqual((await call('/api/transparency/donations?status=Verified&pageSize=1')).data.pages, 3);
    });

    console.log('Expenses, receipts & balance');
    const addExp = (body, tok = admin) => call('/api/admin/finance/expenses', { method: 'POST', token: tok, body });
    let e1, e2;
    await t('only admins can add expenses; invalid input is rejected', async () => {
      const ok = { date: today, title: 'Dog food 25kg', category: 'Animal food', amount: '400.25' };
      assert.strictEqual((await addExp(ok, null)).status, 401); assert.strictEqual((await addExp(ok, maria)).status, 401);
      for (const bad of [{ ...ok, amount: '-5' }, { ...ok, amount: '0' }, { ...ok, amount: '12.345' }, { ...ok, amount: 'abc' }, { ...ok, category: 'Pizza' }, { ...ok, title: 'x' }, { ...ok, date: '2999-01-01' }, { ...ok, date: '2026-02-30' }, { ...ok, animalId: 'NOPE' }]) assert.strictEqual((await addExp(bad)).status, 400, JSON.stringify(bad));
    });
    await t('recording an expense updates the balance (server-calculated)', async () => {
      e1 = (await addExp({ date: today, title: 'Dog food 25kg', category: 'Animal food', amount: '400.25' })).data; assert.ok(e1.expenseId);
      e2 = (await addExp({ date: today, title: 'Rabies vaccine x3', category: 'Vaccination', amount: 600, description: 'Batch for Purok 3' })).data;
      const s = (await call('/api/transparency/summary')).data; assert.strictEqual(s.expensesTotal, 1000.25); assert.strictEqual(s.remainingBalance, 500.25); assert.strictEqual(s.expenseCount, 2);
      assert.strictEqual(s.categories.find(c => c.category === 'Vaccination').amount, 600);
    });
    await t('the same expense twice in a minute is blocked', async () => assert.strictEqual((await addExp({ date: today, title: 'Dog food 25kg', category: 'Animal food', amount: '400.25' })).status, 409));
    await t('private receipt: stranger blocked, admin allowed; fake files rejected', async () => {
      const up = (id, receipt) => call(`/api/admin/finance/expenses/${id}/receipts`, { method: 'POST', token: admin, body: { receipt } });
      const r = await up(e1.expenseId, { data: PNG, name: 'official receipt.png' }); assert.strictEqual(r.status, 200);
      assert.strictEqual((await call(`/api/transparency/receipts/${r.data.receiptId}`)).status, 401); assert.strictEqual((await call(`/api/transparency/receipts/${r.data.receiptId}`, { token: admin })).status, 200);
      assert.strictEqual((await up(e1.expenseId, { data: 'data:image/png;base64,' + Buffer.from('<script>alert(1)</script>').toString('base64'), name: 'x.png' })).status, 400);
      assert.strictEqual((await up(e1.expenseId, { data: 'data:text/html;base64,PGI+', name: 'x.html' })).status, 400);
      assert.strictEqual((await up(e1.expenseId, { data: 'data:application/pdf;base64,' + Buffer.concat([Buffer.from('%PDF-'), Buffer.alloc(2.1e6, 65)]).toString('base64') })).status, 400, 'over 2 MB rejected');
      assert.strictEqual((await call(`/api/admin/finance/receipts/${r.data.receiptId}`, { method: 'PUT', token: admin, body: { isPublic: true } })).status, 400, 'needs redaction confirmation');
      assert.strictEqual((await call(`/api/admin/finance/receipts/${r.data.receiptId}`, { method: 'PUT', token: admin, body: { isPublic: true, confirmRedacted: true } })).status, 200);
      const pub = await call(`/api/transparency/receipts/${r.data.receiptId}`); assert.strictEqual(pub.status, 200); assert.strictEqual(pub.headers.get('content-type'), 'image/png'); assert.strictEqual(pub.headers.get('x-content-type-options'), 'nosniff');
      const list = (await call('/api/transparency/expenses')).data.rows; assert.strictEqual(list.find(x => x.id === e1.expenseId).receiptState, 'public'); assert.strictEqual(list.find(x => x.id === e2.expenseId).receiptState, 'none');
      assert.ok(!JSON.stringify(list).includes('official receipt'), 'file names are not public');
    });
    await t('editing needs a reason and keeps the old values in the audit log', async () => {
      const put = (b) => call(`/api/admin/finance/expenses/${e2.expenseId}`, { method: 'PUT', token: admin, body: b });
      const base = { date: today, title: 'Rabies vaccine x3', category: 'Vaccination', amount: '450' };
      assert.strictEqual((await put(base)).status, 400); assert.strictEqual((await put({ ...base, reason: 'Typo: supplier charged 450' })).status, 200);
      const a = (await call('/api/admin/finance/audit', { token: admin })).data.rows.find(x => x.entity === 'expense' && x.entityId === e2.expenseId && x.action === 'correction');
      assert.strictEqual(a.oldValues.amount, 600); assert.strictEqual(a.newValues.amount, 450); assert.strictEqual(a.reason, 'Typo: supplier charged 450'); assert.strictEqual(a.admin, 'Barangay Administrator');
      assert.strictEqual((await call('/api/transparency/summary')).data.remainingBalance, 650.25);
    });
    await t('voiding removes it from totals but keeps the record', async () => {
      assert.strictEqual((await call(`/api/admin/finance/expenses/${e2.expenseId}/void`, { method: 'POST', token: admin, body: {} })).status, 400);
      assert.strictEqual((await call(`/api/admin/finance/expenses/${e2.expenseId}/void`, { method: 'POST', token: admin, body: { reason: 'Duplicate of invoice' } })).status, 200);
      const s = (await call('/api/transparency/summary')).data; assert.strictEqual(s.expensesTotal, 400.25); assert.strictEqual(s.remainingBalance, 1100.25);
      assert.ok(!(await call('/api/transparency/expenses')).data.rows.some(x => x.id === e2.expenseId)); assert.ok((await call('/api/admin/finance/expenses', { token: admin })).data.rows.some(x => x.id === e2.expenseId && x.status === 'Voided'));
    });
    await t('correcting a donation changes the balance and is audited', async () => {
      assert.strictEqual((await call(`/api/admin/finance/donations/${d2.donationId}`, { method: 'PUT', token: admin, body: { amount: '800' } })).status, 400);
      assert.strictEqual((await call(`/api/admin/finance/donations/${d2.donationId}`, { method: 'PUT', token: admin, body: { amount: '800', reason: 'Counted cash again: 800' } })).status, 200);
      assert.strictEqual((await call('/api/transparency/summary')).data.donationsReceived, 1800.5);
      const a = (await call('/api/admin/finance/audit', { token: admin })).data.rows.find(x => x.entity === 'donation' && x.action === 'correction'); assert.strictEqual(a.oldValues.amount, 500); assert.strictEqual(a.newValues.amount, 800);
    });
    await t('database refuses to delete expenses or edit the audit log', async () => {
      const { DatabaseSync } = require('node:sqlite'), d = new DatabaseSync(dbFile);
      assert.throws(() => d.exec('DELETE FROM expenses'), /cannot be deleted/); assert.throws(() => d.exec('DELETE FROM financial_audit_log'), /append-only/); assert.throws(() => d.exec("UPDATE financial_audit_log SET Reason='x'"), /append-only/); d.close();
    });
    await t('floating point does not drift (0.1 + 0.2 style amounts)', async () => {
      for (const a of ['0.10', '0.20']) { const x = (await donate(maria, a, 'Cash')).data; await status(x.donationId, 'Verified'); }
      const s = (await call('/api/transparency/summary')).data; assert.strictEqual(Math.round(s.donationsReceived * 100), 180080);
    });

    console.log('Reports');
    await t('report: opening + donations − expenses = closing, and matches the dashboard', async () => {
      const r = (await call(`/api/admin/finance/report?from=2000-01-01&to=${today}`, { token: admin })).data, s = (await call('/api/transparency/summary')).data;
      assert.strictEqual(r.openingBalance, 0); assert.strictEqual(r.closingBalance, s.remainingBalance); assert.strictEqual(r.balanceCheckToDate, s.remainingBalance); assert.strictEqual(Math.round((r.openingBalance + r.donations.total - r.expenses.total) * 100), Math.round(r.closingBalance * 100));
      assert.strictEqual(r.categories.length, 7); assert.strictEqual(r.categories.reduce((a, c) => a + Math.round(c.amount * 100), 0), Math.round(r.expenses.total * 100));
      const future = (await call(`/api/admin/finance/report?from=2999-01-01&to=2999-12-31`, { token: admin })).data; assert.strictEqual(future.openingBalance, s.remainingBalance);
      assert.strictEqual((await call('/api/admin/finance/report?from=2026-05-01&to=2026-04-01', { token: admin })).status, 400); assert.strictEqual((await call(`/api/admin/finance/report?from=2000-01-01&to=${today}`)).status, 401);
    });
    await t('CSV report downloads with matching numbers and safe cells', async () => {
      await addExp({ date: today, title: '=HYPERLINK("http://evil")', category: 'Other animal welfare expenses', amount: '1' });
      const r = await call(`/api/admin/finance/report?from=2000-01-01&to=${today}&format=csv`, { token: admin }), txt = r.data.toString('utf8');
      assert.ok(r.headers.get('content-disposition').includes('attachment')); assert.ok(txt.includes('Closing balance')); assert.ok(txt.includes(`"'=HYPERLINK`), 'formula injection neutralised'); assert.ok(!/maria@|juan@/.test(txt));
    });
    await t('published updates appear on the public page; unpublished ones disappear', async () => {
      const u = (await call('/api/admin/finance/updates', { method: 'POST', token: admin, body: { title: 'October vaccination drive', body: 'We vaccinated 12 strays.' } })).data;
      assert.strictEqual((await call('/api/transparency/updates')).data.updates.length, 1);
      assert.strictEqual((await call('/api/admin/finance/updates', { method: 'POST', token: maria, body: { title: 'abc', body: 'hello world' } })).status, 401);
      await call(`/api/admin/finance/updates/${u.updateId}`, { method: 'PUT', token: admin, body: { status: 'Unpublished' } }); assert.strictEqual((await call('/api/transparency/updates')).data.updates.length, 0);
    });


    console.log('Authorization sweep');
    await t('every admin finance endpoint rejects visitors and normal users', async () => {
      const eps = [['GET', '/api/admin/finance/overview'], ['GET', '/api/admin/finance/donations'], ['PUT', '/api/admin/finance/donations/1/status'], ['PUT', '/api/admin/finance/donations/1'], ['GET', '/api/admin/finance/expenses'], ['POST', '/api/admin/finance/expenses'], ['PUT', '/api/admin/finance/expenses/1'], ['POST', '/api/admin/finance/expenses/1/void'], ['POST', '/api/admin/finance/expenses/1/receipts'], ['PUT', '/api/admin/finance/receipts/1'], ['GET', '/api/admin/finance/updates'], ['POST', '/api/admin/finance/updates'], ['PUT', '/api/admin/finance/updates/1'], ['GET', '/api/admin/finance/audit'], ['GET', '/api/admin/finance/report?from=2020-01-01&to=2020-12-31']];
      for (const [m, p] of eps) for (const tok of [null, maria]) { const r = await call(p, { method: m, token: tok, body: m === 'GET' ? undefined : {} }); assert.strictEqual(r.status, 401, `${m} ${p} as ${tok ? 'user' : 'visitor'} -> ${r.status}`); }
    });
    await t('private/missing receipts look the same to the public', async () => { assert.strictEqual((await call('/api/transparency/receipts/99999')).status, 401); });

    console.log('Existing features still work');
    await t('animals, public stats, login, adoption routes respond', async () => {
      assert.strictEqual((await call('/api/animals')).status, 200); assert.strictEqual((await call('/api/public')).status, 200);
      assert.strictEqual((await call('/api/my/donations', { token: maria })).status, 200); assert.strictEqual((await call('/api/admin/accounts', { token: admin })).status, 200);
      const rep = (await call('/api/admin/system-reports', { method: 'POST', token: admin, body: { reportType: 'Donations' } })); assert.strictEqual(rep.status, 200);
      const list = (await call('/api/admin/system-reports', { token: admin })).data[0].PublicInformation.summary; assert.ok('Verified cash/GCash donations (₱)' in list);
    });
  } finally { srv.kill(); try { fs.unlinkSync(dbFile); } catch {} }
  console.log(`\n${pass} checks passed${process.exitCode ? ' — SOME FAILED' : ''}`);
})();
