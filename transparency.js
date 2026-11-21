'use strict';
// PurrID – Donation Transparency System.
// Installed from server.js. Shares the same SQLite database, sessions and admin authentication.
//
// Rules this module enforces on the SERVER (the browser is never trusted for money):
//  * Remaining balance = VERIFIED cash/GCash donations − ACTIVE (non-voided) expenses, always computed from the database.
//  * Pending / rejected / cancelled donations and In-Kind items are never counted as funds.
//  * Money is summed as integer centavos (no floating-point drift).
//  * Financial rows are never deleted or silently overwritten: edits need a reason and are written to an
//    append-only audit log (old + new values); expenses are "voided", not deleted.
//  * Only admins can write. The public can only read published/safe data (no emails, phones, user IDs, full names).

module.exports = function installTransparency({ db, q, q1, run, tx, fail, str, today, need, R }) {
  const crypto = require('crypto');

  // ---------------------------------------------------------------- constants
  const CATEGORIES = ['Animal food', 'Veterinary consultation', 'Medicines and treatments', 'Vaccination', 'Rescue and transportation', 'Shelter and supplies', 'Other animal welfare expenses'];
  const DON_STATUS = ['Pending', 'Verified', 'Rejected', 'Cancelled'];
  const DON_TYPES = ['Cash', 'GCash', 'In-Kind'];
  const FUND_TYPES_SQL = "('Cash','GCash')"; // only these are real money that can be spent
  const MAX_CENTS = 1e9; // ₱10,000,000, same ceiling as the donation form
  const MAX_RECEIPT_BYTES = 2e6;
  const RECEIPT_EXT = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'application/pdf': 'pdf' };

  // ---------------------------------------------------------------- migration (idempotent; keeps existing rows)
  const cols = t => q(`PRAGMA table_info(${t})`).map(c => c.name);
  const addCol = (t, c, def) => { if (!cols(t).includes(c)) db.exec(`ALTER TABLE ${t} ADD COLUMN ${c} ${def}`); };
  tx(() => {
    // Existing donations are kept untouched and start as 'Pending' until an administrator verifies them.
    addCol('donations', 'VerificationStatus', "TEXT NOT NULL DEFAULT 'Pending'");
    addCol('donations', 'VerifiedBy', 'INTEGER REFERENCES admins(AdminID)');
    addCol('donations', 'VerifiedAt', 'TEXT');
    addCol('donations', 'ShowName', 'INTEGER NOT NULL DEFAULT 0'); // donor consent to show "First L." publicly
    addCol('donations', 'IdempotencyKey', 'TEXT'); // stops double submissions
    db.exec(`
CREATE UNIQUE INDEX IF NOT EXISTS ux_donation_idem ON donations(UserID,IdempotencyKey) WHERE IdempotencyKey IS NOT NULL;
CREATE TABLE IF NOT EXISTS expenses(ExpenseID INTEGER PRIMARY KEY AUTOINCREMENT,ExpenseDate TEXT NOT NULL,Title TEXT NOT NULL,Category TEXT NOT NULL,AmountCents INTEGER NOT NULL CHECK(AmountCents>0),Description TEXT,AnimalID TEXT,Project TEXT,Status TEXT NOT NULL DEFAULT 'Active',VoidReason TEXT,RecordedBy INTEGER NOT NULL REFERENCES admins(AdminID),CreatedAt TEXT NOT NULL,UpdatedAt TEXT);
CREATE INDEX IF NOT EXISTS ix_expenses_date ON expenses(ExpenseDate);
CREATE TABLE IF NOT EXISTS expense_receipts(ReceiptID INTEGER PRIMARY KEY AUTOINCREMENT,ExpenseID INTEGER NOT NULL REFERENCES expenses(ExpenseID),MimeType TEXT NOT NULL,FileName TEXT,SizeBytes INTEGER NOT NULL,Sha256 TEXT NOT NULL,Data BLOB NOT NULL,IsPublic INTEGER NOT NULL DEFAULT 0,UploadedBy INTEGER REFERENCES admins(AdminID),UploadedAt TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS transparency_updates(UpdateID INTEGER PRIMARY KEY AUTOINCREMENT,Title TEXT NOT NULL,Body TEXT NOT NULL,Status TEXT NOT NULL DEFAULT 'Published',AdminID INTEGER NOT NULL REFERENCES admins(AdminID),CreatedAt TEXT NOT NULL,UpdatedAt TEXT);
CREATE TABLE IF NOT EXISTS financial_audit_log(AuditID INTEGER PRIMARY KEY AUTOINCREMENT,EntityType TEXT NOT NULL,EntityID INTEGER NOT NULL,Action TEXT NOT NULL,OldValues TEXT,NewValues TEXT,Reason TEXT,AdminID INTEGER REFERENCES admins(AdminID),At TEXT NOT NULL);
CREATE TRIGGER IF NOT EXISTS audit_no_update BEFORE UPDATE ON financial_audit_log BEGIN SELECT RAISE(ABORT,'The audit log is append-only'); END;
CREATE TRIGGER IF NOT EXISTS audit_no_delete BEFORE DELETE ON financial_audit_log BEGIN SELECT RAISE(ABORT,'The audit log is append-only'); END;
CREATE TRIGGER IF NOT EXISTS expense_no_delete BEFORE DELETE ON expenses BEGIN SELECT RAISE(ABORT,'Expenses cannot be deleted; void them with a reason instead'); END;
CREATE TRIGGER IF NOT EXISTS receipt_no_delete BEFORE DELETE ON expense_receipts BEGIN SELECT RAISE(ABORT,'Receipts cannot be deleted; hide them from the public instead'); END;`);
  });

  // ---------------------------------------------------------------- helpers
  const now = () => new Date().toISOString();
  const peso = c => c / 100;
  const maxDate = () => new Date(Date.now() + 14 * 3600e3).toISOString().slice(0, 10); // tolerate any timezone's "today"
  const validDate = s => { if (!/^\d{4}-\d{2}-\d{2}$/.test(s || '')) return false; const d = new Date(s + 'T00:00:00Z'); return !isNaN(d) && d.toISOString().slice(0, 10) === s; };
  function dateIn(v, label, { future = false } = {}) {
    const s = str(v, 10); if (!validDate(s)) fail(400, `${label} must be a valid date (YYYY-MM-DD)`);
    if (!future && s > maxDate()) fail(400, `${label} cannot be in the future`);
    return s;
  }
  function centsIn(v, label = 'Amount') {
    const s = String(v ?? '').trim();
    if (!/^\d{1,8}(\.\d{1,2})?$/.test(s)) fail(400, `${label} must be a peso amount with at most 2 decimals`);
    const c = Math.round(parseFloat(s) * 100);
    if (c < 1) fail(400, `${label} must be greater than zero`);
    if (c > MAX_CENTS) fail(400, `${label} is too large`);
    return c;
  }
  const reasonIn = v => { const r = str(v, 300); if (r.length < 5) fail(400, 'Please give a reason (at least 5 characters). It is saved in the audit history.'); return r; };
  const audit = (type, id, action, oldV, newV, reason, adminId) => run('INSERT INTO financial_audit_log(EntityType,EntityID,Action,OldValues,NewValues,Reason,AdminID,At) VALUES(?,?,?,?,?,?,?,?)', type, id, action, oldV ? JSON.stringify(oldV) : null, newV ? JSON.stringify(newV) : null, reason || null, adminId, now());
  const pager = (u, def = 15) => { const size = Math.min(Math.max(parseInt(u.get('pageSize')) || def, 1), 50), page = Math.max(parseInt(u.get('page')) || 1, 1); return { size, page, off: (page - 1) * size }; };
  const pageOut = (rows, total, p) => ({ rows, total, page: p.page, pageSize: p.size, pages: Math.max(1, Math.ceil(total / p.size)) });
  const dateFilters = (u, col, w, p) => {
    for (const [k, op] of [['from', '>='], ['to', '<=']]) if (u.get(k)) { w.push(`${col}${op}?`); p.push(dateIn(u.get(k), k === 'from' ? 'From date' : 'To date', { future: true })); }
  };

  // ---------------------------------------------------------------- THE money calculations (one place only)
  const DC = 'CAST(ROUND(Amount*100) AS INTEGER)';
  const FUND = `VerificationStatus='Verified' AND DonationType IN ${FUND_TYPES_SQL}`;
  function sums({ from = null, to = null, before = null } = {}) {
    const dw = [FUND], dp = [], ew = ["Status='Active'"], ep = [];
    for (const [col, w, p] of [['DateDonated', dw, dp], ['ExpenseDate', ew, ep]]) {
      if (from) { w.push(`${col}>=?`); p.push(from); }
      if (to) { w.push(`${col}<=?`); p.push(to); }
      if (before) { w.push(`${col}<?`); p.push(before); }
    }
    const d = q1(`SELECT COALESCE(SUM(${DC}),0) c,COUNT(*) n FROM donations WHERE ${dw.join(' AND ')}`, ...dp);
    const e = q1(`SELECT COALESCE(SUM(AmountCents),0) c,COUNT(*) n FROM expenses WHERE ${ew.join(' AND ')}`, ...ep);
    return { donC: d.c, donN: d.n, expC: e.c, expN: e.n, balC: d.c - e.c };
  }
  function byCategory(from, to) {
    const w = ["Status='Active'"], p = [];
    if (from) { w.push('ExpenseDate>=?'); p.push(from); }
    if (to) { w.push('ExpenseDate<=?'); p.push(to); }
    return q(`SELECT Category,SUM(AmountCents) c,COUNT(*) n FROM expenses WHERE ${w.join(' AND ')} GROUP BY Category ORDER BY c DESC`, ...p);
  }
  function summary() {
    const s = sums(), cats = byCategory();
    const pend = q1(`SELECT COUNT(*) n,COALESCE(SUM(${DC}),0) c FROM donations WHERE VerificationStatus='Pending' AND DonationType IN ${FUND_TYPES_SQL}`);
    const inKind = q1("SELECT COUNT(*) n FROM donations WHERE VerificationStatus='Verified' AND DonationType='In-Kind'").n;
    const lastE = q1('SELECT MAX(CreatedAt) t FROM expenses').t, lastD = q1("SELECT MAX(VerifiedAt) t FROM donations WHERE VerificationStatus='Verified'").t;
    return {
      currency: 'PHP', donationsReceived: peso(s.donC), donationCount: s.donN, expensesTotal: peso(s.expC), expenseCount: s.expN,
      remainingBalance: peso(s.balC), overspent: s.balC < 0, pendingCount: pend.n, pendingAmount: peso(pend.c), inKindCount: inKind,
      categories: cats.map(x => ({ category: x.Category, amount: peso(x.c), count: x.n, percent: s.expC ? Math.round(x.c * 1000 / s.expC) / 10 : 0 })),
      lastUpdated: [lastE, lastD].filter(Boolean).sort().pop() || null, asOf: now()
    };
  }

  // ---------------------------------------------------------------- receipts
  function magicOk(mime, b) {
    if (mime === 'image/jpeg') return b[0] === 0xFF && b[1] === 0xD8 && b[2] === 0xFF;
    if (mime === 'image/png') return b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]));
    if (mime === 'image/webp') return b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP';
    if (mime === 'application/pdf') return b.subarray(0, 5).toString('latin1') === '%PDF-';
    return false;
  }
  function parseReceipt(r) {
    if (!r) return null;
    const data = String(r.data || ''), i = data.indexOf(','), head = data.slice(0, i), m = /^data:([\w/+.-]+);base64$/.exec(head);
    if (i < 0 || !m || !RECEIPT_EXT[m[1]]) fail(400, 'A receipt must be a JPG, PNG, WEBP or PDF file');
    const body = data.slice(i + 1);
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(body)) fail(400, 'The receipt file is not valid');
    const buf = Buffer.from(body, 'base64');
    if (!buf.length || buf.length > MAX_RECEIPT_BYTES) fail(400, 'A receipt file must be under 2 MB');
    if (!magicOk(m[1], buf)) fail(400, 'The receipt content does not match its file type');
    const isPublic = r.isPublic === true || r.isPublic === 'true';
    if (isPublic && !(r.confirmRedacted === true || r.confirmRedacted === 'true')) fail(400, 'To publish a receipt, confirm that private details (names, numbers, addresses) have been removed');
    return { mime: m[1], buf, name: str(r.name, 80).replace(/[^\w. -]/g, '_') || 'receipt', hash: crypto.createHash('sha256').update(buf).digest('hex'), isPublic: isPublic ? 1 : 0 };
  }
  const insertReceipt = (expenseId, r, adminId) => {
    const x = run('INSERT INTO expense_receipts(ExpenseID,MimeType,FileName,SizeBytes,Sha256,Data,IsPublic,UploadedBy,UploadedAt) VALUES(?,?,?,?,?,?,?,?,?)', expenseId, r.mime, r.name, r.buf.length, r.hash, r.buf, r.isPublic, adminId, now());
    audit('receipt', Number(x.lastInsertRowid), 'upload', null, { expenseId, file: r.name, mime: r.mime, bytes: r.buf.length, sha256: r.hash, public: !!r.isPublic }, null, adminId);
    return Number(x.lastInsertRowid);
  };
  const receiptsOf = (id, admin) => q('SELECT ReceiptID id,MimeType mime,FileName name,SizeBytes size,IsPublic isPublic,UploadedAt uploadedAt FROM expense_receipts WHERE ExpenseID=? ORDER BY ReceiptID', id).filter(r => admin || r.isPublic).map(r => admin ? { ...r, isPublic: !!r.isPublic } : { id: r.id, mime: r.mime });

  // ---------------------------------------------------------------- expense validation
  function cleanExpense(b) {
    const title = str(b.title, 120), category = str(b.category, 60), animal = str(b.animalId, 40) || null;
    if (title.length < 3) fail(400, 'Enter an expense title (at least 3 characters)');
    if (!CATEGORIES.includes(category)) fail(400, 'Choose a valid expense category');
    if (animal && !q1('SELECT 1 x FROM stray_animals WHERE AnimalID=?', animal)) fail(400, 'No registered animal with that Animal ID');
    return { ExpenseDate: dateIn(b.date, 'Expense date'), Title: title, Category: category, AmountCents: centsIn(b.amount, 'Expense amount'), Description: str(b.description, 500) || null, AnimalID: animal, Project: str(b.project, 80) || null };
  }
  const expenseRow = id => q1('SELECT * FROM expenses WHERE ExpenseID=?', id);
  const snap = e => ({ date: e.ExpenseDate, title: e.Title, category: e.Category, amount: peso(e.AmountCents), description: e.Description, animalId: e.AnimalID, project: e.Project, status: e.Status });

  // ================================================================= PUBLIC (read-only, privacy-safe)
  R('GET', /^\/api\/transparency\/summary$/, () => summary());

  R('GET', /^\/api\/transparency\/donations$/, c => {
    const u = c.url.searchParams, p = pager(u), w = ["d.VerificationStatus IN ('Verified','Pending')"], a = [];
    if (u.get('status')) { if (!['Verified', 'Pending'].includes(u.get('status'))) fail(400, 'Invalid status'); w.push('d.VerificationStatus=?'); a.push(u.get('status')); }
    if (u.get('type')) { if (!DON_TYPES.includes(u.get('type'))) fail(400, 'Invalid donation type'); w.push('d.DonationType=?'); a.push(u.get('type')); }
    dateFilters(u, 'd.DateDonated', w, a);
    const total = q1(`SELECT COUNT(*) n FROM donations d WHERE ${w.join(' AND ')}`, ...a).n;
    const rows = q(`SELECT d.Amount,d.DonationType,d.DateDonated,d.VerificationStatus,d.ShowName,u.FirstName,u.LastName FROM donations d JOIN users u ON u.UserID=d.UserID WHERE ${w.join(' AND ')} ORDER BY d.DateDonated DESC,d.DonationID DESC LIMIT ? OFFSET ?`, ...a, p.size, p.off)
      .map(r => ({ date: r.DateDonated, amount: Math.round(r.Amount * 100) / 100, type: r.DonationType, status: r.VerificationStatus, countedInFunds: r.VerificationStatus === 'Verified' && r.DonationType !== 'In-Kind', donor: r.ShowName && r.FirstName ? `${r.FirstName} ${(r.LastName || '')[0] || ''}.`.replace(' .', '') : 'Anonymous donor' }));
    return pageOut(rows, total, p);
  });

  R('GET', /^\/api\/transparency\/expenses$/, c => {
    const u = c.url.searchParams, p = pager(u), w = ["e.Status='Active'"], a = [];
    if (u.get('category')) { if (!CATEGORIES.includes(u.get('category'))) fail(400, 'Invalid category'); w.push('e.Category=?'); a.push(u.get('category')); }
    const t = str(u.get('q'), 60); if (t) { w.push('(e.Title LIKE ? OR e.Description LIKE ? OR e.Project LIKE ?)'); a.push(`%${t}%`, `%${t}%`, `%${t}%`); }
    dateFilters(u, 'e.ExpenseDate', w, a);
    const total = q1(`SELECT COUNT(*) n FROM expenses e WHERE ${w.join(' AND ')}`, ...a).n;
    const rows = q(`SELECT e.*,s.Name AnimalName FROM expenses e LEFT JOIN stray_animals s ON s.AnimalID=e.AnimalID WHERE ${w.join(' AND ')} ORDER BY e.ExpenseDate DESC,e.ExpenseID DESC LIMIT ? OFFSET ?`, ...a, p.size, p.off).map(e => {
      const all = q1('SELECT COUNT(*) n FROM expense_receipts WHERE ExpenseID=?', e.ExpenseID).n, pub = receiptsOf(e.ExpenseID, false);
      return { id: e.ExpenseID, date: e.ExpenseDate, title: e.Title, description: e.Description, category: e.Category, amount: peso(e.AmountCents), project: e.Project, animal: e.AnimalID ? { id: e.AnimalID, name: e.AnimalName } : null, receipts: pub, receiptState: pub.length ? 'public' : all ? 'withheld' : 'none', recordedBy: 'Barangay administrator' };
    });
    return pageOut(rows, total, p);
  });

  R('GET', /^\/api\/transparency\/updates$/, () => {
    const updates = q("SELECT UpdateID id,Title title,Body body,CreatedAt date FROM transparency_updates WHERE Status='Published' ORDER BY UpdateID DESC LIMIT 10");
    const recent = [
      ...q("SELECT Title,AmountCents,Category,CreatedAt FROM expenses WHERE Status='Active' ORDER BY ExpenseID DESC LIMIT 5").map(e => ({ kind: 'expense', at: e.CreatedAt, text: `${e.Title} (${e.Category})`, amount: peso(e.AmountCents) })),
      ...q(`SELECT Amount,VerifiedAt FROM donations WHERE ${FUND} AND VerifiedAt IS NOT NULL ORDER BY VerifiedAt DESC LIMIT 5`).map(d => ({ kind: 'donation', at: d.VerifiedAt, text: 'Donation verified', amount: Math.round(d.Amount * 100) / 100 }))
    ].sort((x, y) => y.at.localeCompare(x.at)).slice(0, 6);
    return { updates, recent };
  });

  R('GET', /^\/api\/transparency\/receipts\/(\d+)$/, c => { // public only for receipts an admin marked safe to publish
    const r = q1('SELECT r.*,e.Status ES FROM expense_receipts r JOIN expenses e USING(ExpenseID) WHERE r.ReceiptID=?', c.m[1]);
    if (!(r && r.IsPublic && r.ES === 'Active')) need(c, 'admin'); // same answer for "private" and "missing" to non-admins
    if (!r) fail(404, 'Receipt not found');
    return { __raw: { headers: { 'Content-Type': r.MimeType, 'Content-Length': r.SizeBytes, 'Content-Disposition': `inline; filename="receipt-${r.ReceiptID}.${RECEIPT_EXT[r.MimeType]}"`, 'X-Content-Type-Options': 'nosniff', 'Cache-Control': r.IsPublic ? 'public, max-age=300' : 'private, no-store' }, body: Buffer.from(r.Data) } };
  });

  // ================================================================= ADMIN
  R('GET', /^\/api\/admin\/finance\/overview$/, c => {
    need(c, 'admin');
    return { ...summary(), categoriesList: CATEGORIES, recentAudit: auditRows(8, 0).rows };
  });

  // ---- donations
  R('GET', /^\/api\/admin\/finance\/donations$/, c => {
    need(c, 'admin');
    const u = c.url.searchParams, p = pager(u, 20), w = ['1=1'], a = [];
    if (u.get('status')) { if (!DON_STATUS.includes(u.get('status'))) fail(400, 'Invalid status'); w.push('d.VerificationStatus=?'); a.push(u.get('status')); }
    const total = q1(`SELECT COUNT(*) n FROM donations d WHERE ${w.join(' AND ')}`, ...a).n;
    const rows = q(`SELECT d.DonationID id,d.Amount amount,d.DonationType type,d.DateDonated date,d.VerificationStatus status,d.VerifiedAt verifiedAt,d.ShowName showName,u.FirstName||' '||u.LastName donor,u.Email email,ad.FirstName||' '||ad.LastName verifiedBy FROM donations d JOIN users u ON u.UserID=d.UserID LEFT JOIN admins ad ON ad.AdminID=d.VerifiedBy WHERE ${w.join(' AND ')} ORDER BY (d.VerificationStatus='Pending') DESC,d.DonationID DESC LIMIT ? OFFSET ?`, ...a, p.size, p.off).map(r => ({ ...r, showName: !!r.showName }));
    return pageOut(rows, total, p);
  });
  R('PUT', /^\/api\/admin\/finance\/donations\/(\d+)\/status$/, c => { // verify / reject / cancel / reopen
    const s = need(c, 'admin'), d = q1('SELECT * FROM donations WHERE DonationID=?', c.m[1]), st = c.b.status;
    if (!d) fail(404, 'Donation not found');
    if (!DON_STATUS.includes(st)) fail(400, 'Invalid status');
    if (st === d.VerificationStatus) fail(409, `This donation is already ${st}`);
    const reason = (d.VerificationStatus !== 'Pending' || ['Rejected', 'Cancelled'].includes(st)) ? reasonIn(c.b.reason) : (str(c.b.reason, 300) || null);
    tx(() => {
      run('UPDATE donations SET VerificationStatus=?,VerifiedBy=?,VerifiedAt=? WHERE DonationID=?', st, st === 'Pending' ? null : s.id, st === 'Pending' ? null : now(), d.DonationID);
      audit('donation', d.DonationID, 'status_change', { status: d.VerificationStatus, amount: d.Amount, type: d.DonationType }, { status: st }, reason, s.id);
    });
    return { message: `Donation #${d.DonationID} marked ${st}`, summary: summary() };
  });
  R('PUT', /^\/api\/admin\/finance\/donations\/(\d+)$/, c => { // correction of wrong details, with reason + history
    const s = need(c, 'admin'), d = q1('SELECT * FROM donations WHERE DonationID=?', c.m[1]), b = c.b;
    if (!d) fail(404, 'Donation not found');
    const reason = reasonIn(b.reason), nu = { amount: d.Amount, type: d.DonationType, date: d.DateDonated };
    if (b.amount !== undefined && b.amount !== '') nu.amount = peso(centsIn(b.amount, 'Donation amount'));
    if (b.type) { if (!DON_TYPES.includes(b.type)) fail(400, 'Invalid donation type'); nu.type = b.type; }
    if (b.date) nu.date = dateIn(b.date, 'Date received');
    const old = { amount: d.Amount, type: d.DonationType, date: d.DateDonated };
    if (JSON.stringify(old) === JSON.stringify(nu)) fail(400, 'Nothing was changed');
    tx(() => { run('UPDATE donations SET Amount=?,DonationType=?,DateDonated=? WHERE DonationID=?', nu.amount, nu.type, nu.date, d.DonationID); audit('donation', d.DonationID, 'correction', old, nu, reason, s.id); });
    return { message: `Donation #${d.DonationID} corrected. The previous values are kept in the audit history.`, summary: summary() };
  });

  // ---- expenses
  R('GET', /^\/api\/admin\/finance\/expenses$/, c => {
    need(c, 'admin');
    const u = c.url.searchParams, p = pager(u, 20), total = q1('SELECT COUNT(*) n FROM expenses').n;
    const rows = q('SELECT e.*,s.Name AnimalName,a.FirstName||\' \'||a.LastName Admin FROM expenses e LEFT JOIN stray_animals s ON s.AnimalID=e.AnimalID LEFT JOIN admins a ON a.AdminID=e.RecordedBy ORDER BY e.ExpenseDate DESC,e.ExpenseID DESC LIMIT ? OFFSET ?', p.size, p.off).map(e => ({ id: e.ExpenseID, date: e.ExpenseDate, title: e.Title, category: e.Category, amount: peso(e.AmountCents), description: e.Description, animalId: e.AnimalID, animalName: e.AnimalName, project: e.Project, status: e.Status, voidReason: e.VoidReason, recordedBy: e.Admin, receipts: receiptsOf(e.ExpenseID, true) }));
    return pageOut(rows, total, p);
  });
  R('POST', /^\/api\/admin\/finance\/expenses$/, c => {
    const s = need(c, 'admin'), e = cleanExpense(c.b), rc = parseReceipt(c.b.receipt);
    const dup = q1("SELECT 1 x FROM expenses WHERE RecordedBy=? AND ExpenseDate=? AND Title=? AND AmountCents=? AND Category=? AND CreatedAt>?", s.id, e.ExpenseDate, e.Title, e.AmountCents, e.Category, new Date(Date.now() - 60e3).toISOString());
    if (dup) fail(409, 'This exact expense was just recorded. Refresh the list before adding it again.');
    const id = tx(() => {
      const r = run('INSERT INTO expenses(ExpenseDate,Title,Category,AmountCents,Description,AnimalID,Project,RecordedBy,CreatedAt) VALUES(?,?,?,?,?,?,?,?,?)', e.ExpenseDate, e.Title, e.Category, e.AmountCents, e.Description, e.AnimalID, e.Project, s.id, now());
      const id = Number(r.lastInsertRowid); audit('expense', id, 'create', null, snap({ ...e, Status: 'Active' }), null, s.id);
      if (rc) insertReceipt(id, rc, s.id);
      return id;
    });
    const sm = summary();
    return { expenseId: id, message: `Expense #${id} recorded. Remaining balance is now ${fmt(sm.remainingBalance)}.`, warning: sm.overspent ? 'Recorded expenses are now higher than verified donations.' : null, summary: sm };
  });
  R('PUT', /^\/api\/admin\/finance\/expenses\/(\d+)$/, c => {
    const s = need(c, 'admin'), old = expenseRow(c.m[1]);
    if (!old) fail(404, 'Expense not found');
    if (old.Status !== 'Active') fail(409, 'A voided expense cannot be edited');
    const reason = reasonIn(c.b.reason), e = cleanExpense(c.b);
    const before = snap(old), after = snap({ ...e, Status: 'Active' });
    if (JSON.stringify(before) === JSON.stringify(after)) fail(400, 'Nothing was changed');
    tx(() => { run('UPDATE expenses SET ExpenseDate=?,Title=?,Category=?,AmountCents=?,Description=?,AnimalID=?,Project=?,UpdatedAt=? WHERE ExpenseID=?', e.ExpenseDate, e.Title, e.Category, e.AmountCents, e.Description, e.AnimalID, e.Project, now(), old.ExpenseID); audit('expense', old.ExpenseID, 'correction', before, after, reason, s.id); });
    return { message: `Expense #${old.ExpenseID} corrected. The previous values are kept in the audit history.`, summary: summary() };
  });
  R('POST', /^\/api\/admin\/finance\/expenses\/(\d+)\/void$/, c => {
    const s = need(c, 'admin'), old = expenseRow(c.m[1]);
    if (!old) fail(404, 'Expense not found');
    if (old.Status !== 'Active') fail(409, 'This expense is already voided');
    const reason = reasonIn(c.b.reason);
    tx(() => { run("UPDATE expenses SET Status='Voided',VoidReason=?,UpdatedAt=? WHERE ExpenseID=?", reason, now(), old.ExpenseID); audit('expense', old.ExpenseID, 'void', snap(old), { status: 'Voided' }, reason, s.id); });
    return { message: `Expense #${old.ExpenseID} voided. It is no longer counted, and the record stays in the audit history.`, summary: summary() };
  });
  R('POST', /^\/api\/admin\/finance\/expenses\/(\d+)\/receipts$/, c => {
    const s = need(c, 'admin'), e = expenseRow(c.m[1]);
    if (!e) fail(404, 'Expense not found');
    if (e.Status !== 'Active') fail(409, 'Receipts cannot be added to a voided expense');
    const rc = parseReceipt(c.b.receipt); if (!rc) fail(400, 'Choose a receipt file');
    const id = tx(() => insertReceipt(e.ExpenseID, rc, s.id));
    return { receiptId: id, message: rc.isPublic ? 'Receipt uploaded and published' : 'Receipt uploaded (kept private until you publish it)' };
  });
  R('PUT', /^\/api\/admin\/finance\/receipts\/(\d+)$/, c => {
    const s = need(c, 'admin'), r = q1('SELECT ReceiptID,ExpenseID,IsPublic FROM expense_receipts WHERE ReceiptID=?', c.m[1]);
    if (!r) fail(404, 'Receipt not found');
    const pub = c.b.isPublic === true || c.b.isPublic === 'true' ? 1 : 0;
    if (pub && !(c.b.confirmRedacted === true || c.b.confirmRedacted === 'true')) fail(400, 'To publish a receipt, confirm that private details (names, numbers, addresses) have been removed');
    if (pub === r.IsPublic) fail(409, 'No change');
    tx(() => { run('UPDATE expense_receipts SET IsPublic=? WHERE ReceiptID=?', pub, r.ReceiptID); audit('receipt', r.ReceiptID, pub ? 'publish' : 'unpublish', { public: !!r.IsPublic }, { public: !!pub }, str(c.b.reason, 300) || null, s.id); });
    return { message: pub ? 'Receipt is now public' : 'Receipt is now private' };
  });

  // ---- transparency updates (published posts)
  R('GET', /^\/api\/admin\/finance\/updates$/, c => { need(c, 'admin'); return q('SELECT UpdateID id,Title title,Body body,Status status,CreatedAt createdAt,UpdatedAt updatedAt FROM transparency_updates ORDER BY UpdateID DESC LIMIT 50'); });
  R('POST', /^\/api\/admin\/finance\/updates$/, c => {
    const s = need(c, 'admin'), title = str(c.b.title, 120), body = str(c.b.body, 2000);
    if (title.length < 3 || body.length < 5) fail(400, 'Enter a title and a message');
    const id = tx(() => { const r = run("INSERT INTO transparency_updates(Title,Body,Status,AdminID,CreatedAt) VALUES(?,?,'Published',?,?)", title, body, s.id, now()); audit('update', Number(r.lastInsertRowid), 'publish', null, { title, body }, null, s.id); return Number(r.lastInsertRowid); });
    return { updateId: id, message: 'Update published on the transparency page' };
  });
  R('PUT', /^\/api\/admin\/finance\/updates\/(\d+)$/, c => {
    const s = need(c, 'admin'), u = q1('SELECT * FROM transparency_updates WHERE UpdateID=?', c.m[1]);
    if (!u) fail(404, 'Update not found');
    const title = 'title' in c.b ? str(c.b.title, 120) : u.Title, body = 'body' in c.b ? str(c.b.body, 2000) : u.Body, st = c.b.status || u.Status;
    if (!['Published', 'Unpublished'].includes(st)) fail(400, 'Invalid status');
    if (title.length < 3 || body.length < 5) fail(400, 'Enter a title and a message');
    tx(() => { run('UPDATE transparency_updates SET Title=?,Body=?,Status=?,UpdatedAt=? WHERE UpdateID=?', title, body, st, now(), u.UpdateID); audit('update', u.UpdateID, st !== u.Status ? st.toLowerCase().replace('ed', '') : 'edit', { title: u.Title, body: u.Body, status: u.Status }, { title, body, status: st }, str(c.b.reason, 300) || null, s.id); });
    return { message: 'Update saved' };
  });

  // ---- audit history
  function auditRows(size, off) {
    const total = q1('SELECT COUNT(*) n FROM financial_audit_log').n;
    const rows = q('SELECT l.AuditID id,l.EntityType entity,l.EntityID entityId,l.Action action,l.OldValues oldValues,l.NewValues newValues,l.Reason reason,l.At at,a.FirstName||\' \'||a.LastName admin FROM financial_audit_log l LEFT JOIN admins a ON a.AdminID=l.AdminID ORDER BY l.AuditID DESC LIMIT ? OFFSET ?', size, off).map(r => ({ ...r, oldValues: r.oldValues ? JSON.parse(r.oldValues) : null, newValues: r.newValues ? JSON.parse(r.newValues) : null }));
    return { rows, total };
  }
  R('GET', /^\/api\/admin\/finance\/audit$/, c => { need(c, 'admin'); const p = pager(c.url.searchParams, 20), o = auditRows(p.size, p.off); return pageOut(o.rows, o.total, p); });

  // ---- reports (same calculation functions as the dashboard, so the numbers always agree)
  const fmt = n => (n < 0 ? '-' : '') + '₱' + Math.abs(Number(n)).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  function buildReport(from, to, notes) {
    const open = sums({ before: from }), per = sums({ from, to }), upTo = sums({ to });
    const closeC = open.balC + per.donC - per.expC;
    const cats = byCategory(from, to), cm = Object.fromEntries(cats.map(x => [x.Category, x]));
    const donations = q(`SELECT DateDonated,DonationType,Amount FROM donations WHERE ${FUND} AND DateDonated>=? AND DateDonated<=? ORDER BY DateDonated,DonationID`, from, to).map(d => ({ date: d.DateDonated, type: d.DonationType, amount: Math.round(d.Amount * 100) / 100 }));
    const expenses = q("SELECT e.ExpenseID,e.ExpenseDate,e.Title,e.Category,e.AmountCents,e.AnimalID,e.Project,(SELECT COUNT(*) FROM expense_receipts r WHERE r.ExpenseID=e.ExpenseID) rc,(SELECT COUNT(*) FROM expense_receipts r WHERE r.ExpenseID=e.ExpenseID AND r.IsPublic=1) pc FROM expenses e WHERE e.Status='Active' AND e.ExpenseDate>=? AND e.ExpenseDate<=? ORDER BY e.ExpenseDate,e.ExpenseID", from, to).map(e => ({ id: e.ExpenseID, date: e.ExpenseDate, title: e.Title, category: e.Category, amount: peso(e.AmountCents), animalId: e.AnimalID, project: e.Project, receipts: e.rc, publicReceipts: e.pc }));
    const pend = q1(`SELECT COUNT(*) n,COALESCE(SUM(${DC}),0) c FROM donations WHERE VerificationStatus='Pending' AND DonationType IN ${FUND_TYPES_SQL} AND DateDonated>=? AND DateDonated<=?`, from, to);
    const inKind = q1("SELECT COUNT(*) n FROM donations WHERE VerificationStatus='Verified' AND DonationType='In-Kind' AND DateDonated>=? AND DateDonated<=?", from, to).n;
    return {
      currency: 'PHP', generatedAt: now(), period: { from, to }, openingBalance: peso(open.balC),
      donations: { count: per.donN, total: peso(per.donC), items: donations }, expenses: { count: per.expN, total: peso(per.expC), items: expenses },
      categories: CATEGORIES.map(k => ({ category: k, amount: peso(cm[k] ? cm[k].c : 0), count: cm[k] ? cm[k].n : 0 })),
      closingBalance: peso(closeC), balanceCheckToDate: peso(upTo.balC), // closing equals the dashboard balance when the period ends today
      notCounted: { pendingDonations: pend.n, pendingAmount: peso(pend.c), inKindVerifiedItems: inKind }, notes: notes || ''
    };
  }
  const csvCell = v => { let s = typeof v === 'number' ? (Number.isInteger(v) ? String(v) : v.toFixed(2)) : String(v ?? ''); if (typeof v === 'string' && /^[=+\-@\t\r]/.test(s)) s = "'" + s; return `"${s.replace(/"/g, '""')}"`; };
  function reportCsv(r) {
    const L = [], row = (...a) => L.push(a.map(csvCell).join(','));
    row('PurrID – Donation transparency report'); row('Barangay Tinurik, Tanauan City, Batangas'); row('Currency', 'PHP (₱)'); row('Reporting period', `${r.period.from} to ${r.period.to}`); row('Generated', r.generatedAt); row();
    row('SUMMARY'); row('Opening balance', r.openingBalance); row('Verified cash/GCash donations received', r.donations.total); row('Expenses', r.expenses.total); row('Closing balance', r.closingBalance); row();
    row('EXPENSE BREAKDOWN BY CATEGORY'); row('Category', 'Amount', 'Number of expenses'); r.categories.forEach(c => row(c.category, c.amount, c.count)); row();
    row('DONATIONS RECEIVED (verified, donor identities not included)'); row('Date', 'Type', 'Amount'); r.donations.items.forEach(d => row(d.date, d.type, d.amount)); row();
    row('EXPENSES'); row('Expense no.', 'Date', 'Title', 'Category', 'Amount', 'Related animal', 'Project', 'Receipts on file', 'Public receipts'); r.expenses.items.forEach(e => row(e.id, e.date, e.title, e.category, e.amount, e.animalId || '', e.project || '', e.receipts, e.publicReceipts)); row();
    row('NOT COUNTED IN THE BALANCE'); row('Pending cash/GCash donations awaiting verification', r.notCounted.pendingDonations, r.notCounted.pendingAmount); row('Verified in-kind donation items (not cash)', r.notCounted.inKindVerifiedItems); row();
    row('NOTES'); row(r.notes || '(none)');
    return '\uFEFF' + L.join('\r\n') + '\r\n';
  }
  R('GET', /^\/api\/admin\/finance\/report$/, c => {
    const s = need(c, 'admin'), u = c.url.searchParams, from = dateIn(u.get('from'), 'From date', { future: true }), to = dateIn(u.get('to'), 'To date', { future: true });
    if (from > to) fail(400, 'The start date must be on or before the end date');
    const r = buildReport(from, to, str(u.get('notes'), 1000));
    tx(() => audit('report', 0, 'generate', null, { from, to, format: u.get('format') === 'csv' ? 'csv' : 'view', closing: r.closingBalance }, null, s.id));
    if (u.get('format') === 'csv') return { __raw: { headers: { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="purrid-financial-report-${from}_to_${to}.csv"`, 'Cache-Control': 'no-store' }, body: Buffer.from(reportCsv(r), 'utf8') } };
    return r;
  });

  return { summary, sums, CATEGORIES };
};
