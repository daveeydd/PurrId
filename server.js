'use strict';
// PurrID backend: Node built-in http + node:sqlite (Node 22.5+). No npm install needed.
const http = require('http'), fs = require('fs'), path = require('path'), crypto = require('crypto');
const { DatabaseSync } = require('node:sqlite');
const PORT = process.env.PORT || 3000;
const db = new DatabaseSync(process.env.DB_FILE || path.join(__dirname, 'purrid.db'));

// ---------- ERD -> tables (D1 Account Information, D2 Stray Animal, D3 Monitoring, D4 Donation, D5 Adoption, D6 System Reports)
db.exec(`PRAGMA foreign_keys=ON;
CREATE TABLE IF NOT EXISTS admins(AdminID INTEGER PRIMARY KEY AUTOINCREMENT,FirstName TEXT NOT NULL,LastName TEXT NOT NULL,AdminEmail TEXT UNIQUE NOT NULL,Credentials TEXT UNIQUE NOT NULL,Password TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS users(UserID INTEGER PRIMARY KEY AUTOINCREMENT,FirstName TEXT NOT NULL,LastName TEXT NOT NULL,Email TEXT UNIQUE NOT NULL,PhoneNo TEXT,Address TEXT,Role TEXT DEFAULT 'Resident',AccountStatus TEXT DEFAULT 'Active',Password TEXT NOT NULL,AdminID INTEGER REFERENCES admins(AdminID));
CREATE TABLE IF NOT EXISTS adopters(AdopterID INTEGER PRIMARY KEY AUTOINCREMENT,FirstName TEXT NOT NULL,LastName TEXT NOT NULL,Email TEXT UNIQUE NOT NULL,PhoneNo TEXT,Address TEXT,AccountStatus TEXT DEFAULT 'Active',Password TEXT NOT NULL,AdminID INTEGER REFERENCES admins(AdminID));
CREATE TABLE IF NOT EXISTS stray_animals(AnimalID TEXT PRIMARY KEY,Name TEXT,Species TEXT,Breed TEXT,Color TEXT,Sex TEXT,Photo TEXT,RegisterDate TEXT NOT NULL,Status TEXT NOT NULL DEFAULT 'Stray',UserID INTEGER REFERENCES users(UserID),AdminID INTEGER REFERENCES admins(AdminID));
CREATE TABLE IF NOT EXISTS monitoring_reports(ReportID INTEGER PRIMARY KEY AUTOINCREMENT,Date TEXT NOT NULL,Location TEXT,"Condition" TEXT,RescueStatus TEXT DEFAULT 'Reported',UserID INTEGER REFERENCES users(UserID),AnimalID TEXT NOT NULL REFERENCES stray_animals(AnimalID) ON DELETE CASCADE,AdminID INTEGER REFERENCES admins(AdminID));
CREATE TABLE IF NOT EXISTS adoptions(AdoptionID INTEGER PRIMARY KEY AUTOINCREMENT,RequestDate TEXT NOT NULL,AdoptionStatus TEXT DEFAULT 'Pending',DecisionDate TEXT,AdopterID INTEGER NOT NULL REFERENCES adopters(AdopterID),AnimalID TEXT NOT NULL REFERENCES stray_animals(AnimalID) ON DELETE CASCADE,AdminID INTEGER REFERENCES admins(AdminID));
CREATE TABLE IF NOT EXISTS donations(DonationID INTEGER PRIMARY KEY AUTOINCREMENT,Amount REAL NOT NULL,DonationType TEXT NOT NULL,DateDonated TEXT NOT NULL,Acknowledgement TEXT DEFAULT 'Pending',UserID INTEGER NOT NULL REFERENCES users(UserID));
CREATE TABLE IF NOT EXISTS system_reports(ReportID INTEGER PRIMARY KEY AUTOINCREMENT,ReportType TEXT NOT NULL,PublicInformation TEXT,ReportDate TEXT NOT NULL,AdminID INTEGER REFERENCES admins(AdminID));
CREATE TABLE IF NOT EXISTS donation_audits(DonationID INTEGER REFERENCES donations(DonationID) ON DELETE CASCADE,ReportID INTEGER REFERENCES system_reports(ReportID) ON DELETE CASCADE,PRIMARY KEY(DonationID,ReportID));`);

const q = (s, ...p) => db.prepare(s).all(...p), q1 = (s, ...p) => db.prepare(s).get(...p), run = (s, ...p) => db.prepare(s).run(...p);
const tx = f => { db.exec('BEGIN'); try { const r = f(); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; } };
const fail = (code, msg) => { throw { code, msg }; };
const str = (v, n = 200) => (v == null ? '' : String(v).trim().slice(0, n));
const today = () => new Date().toISOString().slice(0, 10);
const hash = p => { const s = crypto.randomBytes(16).toString('hex'); return s + ':' + crypto.scryptSync(p, s, 32).toString('hex'); };
const verify = (p, h) => { const [s, k] = h.split(':'); return crypto.timingSafeEqual(Buffer.from(k, 'hex'), crypto.scryptSync(p, s, 32)); };

if (!q1('SELECT 1 x FROM admins')) // seed one Barangay Tinurik administrator (change the password!)
  run('INSERT INTO admins(FirstName,LastName,AdminEmail,Credentials,Password) VALUES(?,?,?,?,?)', 'Barangay', 'Administrator', 'admin@tinurik.local', 'admin', hash(process.env.ADMIN_PASSWORD || 'admin123'));

const ANIMAL_STATUS = ['Stray', 'Under Rescue', 'Rescued', 'Available for Adoption', 'Pending Adoption', 'Adopted'];
const RESCUE = ['Reported', 'Under Rescue', 'Rescued'];
const SPECIES = ['Dog', 'Cat', 'Other'], SEX = ['Male', 'Female', 'Unknown'];
const sessions = new Map();
const need = (c, ...types) => { if (!c.s || !types.includes(c.s.type)) fail(401, 'Please log in with the correct account type'); return c.s; };
const PUB = 'AnimalID,Name,Species,Breed,Color,Sex,Photo,RegisterDate,Status';

const latest = id => q1('SELECT Date,Location,"Condition",RescueStatus FROM monitoring_reports WHERE AnimalID=? ORDER BY ReportID DESC LIMIT 1', id);
function newAnimalId() { for (;;) { const id = 'PUR-' + today().replace(/-/g, '') + '-' + crypto.randomBytes(2).toString('hex').toUpperCase(); if (!q1('SELECT 1 x FROM stray_animals WHERE AnimalID=?', id)) return id; } }
function setAnimal(id, status, admin) { run('UPDATE stray_animals SET Status=?,AdminID=COALESCE(?,AdminID) WHERE AnimalID=?', status, admin || null, id); }

// ---------- routes
const routes = [];
const R = (m, re, f) => routes.push([m, re, f]);

// 1.0 Manage Accounts (1.1 receive, 1.2 verify, 1.3 save, 1.4 notify status)
R('POST', /^\/api\/register$/, c => {
  const b = c.b, type = b.type;
  if (!['user', 'adopter'].includes(type)) fail(400, 'Choose a User or Adopter account');
  const f = str(b.firstName, 60), l = str(b.lastName, 60), e = str(b.email, 120).toLowerCase(), pw = String(b.password || '');
  if (!f || !l) fail(400, 'First and last name are required');
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e)) fail(400, 'Enter a valid email address');
  if (pw.length < 6) fail(400, 'Password must be at least 6 characters');
  if (q1('SELECT 1 x FROM users WHERE Email=?', e) || q1('SELECT 1 x FROM adopters WHERE Email=?', e)) fail(409, 'An account with this email already exists');
  const ph = str(b.phoneNo, 30), ad = str(b.address, 200);
  if (type === 'user') run('INSERT INTO users(FirstName,LastName,Email,PhoneNo,Address,Role,Password) VALUES(?,?,?,?,?,?,?)', f, l, e, ph, ad, ['Resident', 'Volunteer'].includes(b.role) ? b.role : 'Resident', hash(pw));
  else run('INSERT INTO adopters(FirstName,LastName,Email,PhoneNo,Address,Password) VALUES(?,?,?,?,?,?)', f, l, e, ph, ad, hash(pw));
  return { accountStatus: 'Active', message: 'Account created. Your account status is Active — you can log in now.' };
});
R('POST', /^\/api\/login$/, c => {
  const { type, identifier, password } = c.b, id = str(identifier, 120).toLowerCase(), pw = String(password || '');
  let row, key, name;
  if (type === 'admin') { row = q1('SELECT * FROM admins WHERE lower(Credentials)=? OR lower(AdminEmail)=?', id, id); key = 'AdminID'; }
  else if (type === 'user') { row = q1('SELECT * FROM users WHERE Email=?', id); key = 'UserID'; }
  else if (type === 'adopter') { row = q1('SELECT * FROM adopters WHERE Email=?', id); key = 'AdopterID'; }
  else fail(400, 'Choose an account type');
  if (!row || !verify(pw, row.Password)) fail(401, 'Incorrect login details');
  if (row.AccountStatus && row.AccountStatus !== 'Active') fail(403, `Your account status is ${row.AccountStatus}. Please contact the Barangay Tinurik administrators.`);
  const token = crypto.randomBytes(24).toString('hex');
  sessions.set(token, { type, id: row[key] });
  return { token, type, id: row[key], name: row.FirstName + ' ' + row.LastName };
});
R('POST', /^\/api\/logout$/, c => { sessions.delete(c.token); return { ok: true }; });

// 4.0 Search Animal Records (D2 + D3) / 7.4 public animal information
R('GET', /^\/api\/animals$/, c => {
  const u = c.url.searchParams, w = [], p = [];
  const t = str(u.get('q'), 80);
  if (t) { const l = `%${t}%`; w.push('(AnimalID LIKE ? OR Name LIKE ? OR Species LIKE ? OR Breed LIKE ? OR Color LIKE ? OR AnimalID IN (SELECT AnimalID FROM monitoring_reports WHERE Location LIKE ? OR "Condition" LIKE ?))'); p.push(l, l, l, l, l, l, l); }
  for (const [k, col] of [['species', 'Species'], ['sex', 'Sex'], ['status', 'Status']]) if (u.get(k)) { w.push(col + '=?'); p.push(u.get(k)); }
  const lim = Math.min(+u.get('limit') || 100, 200);
  const rows = q(`SELECT ${PUB} FROM stray_animals ${w.length ? 'WHERE ' + w.join(' AND ') : ''} ORDER BY RegisterDate DESC,AnimalID DESC LIMIT ${lim}`, ...p);
  return rows.map(a => ({ ...a, latest: latest(a.AnimalID) }));
});
R('GET', /^\/api\/animals\/([\w-]+)$/, c => {
  const a = q1(`SELECT ${PUB} FROM stray_animals WHERE AnimalID=?`, c.m[1]);
  if (!a) fail(404, 'Animal record not found');
  return { ...a, monitoring: q('SELECT Date,Location,"Condition",RescueStatus FROM monitoring_reports WHERE AnimalID=? ORDER BY ReportID DESC', a.AnimalID) };
});
R('GET', /^\/api\/public$/, () => ({
  registered: q1('SELECT COUNT(*) n FROM stray_animals').n, available: q1("SELECT COUNT(*) n FROM stray_animals WHERE Status='Available for Adoption'").n,
  underRescue: q1("SELECT COUNT(*) n FROM stray_animals WHERE Status IN ('Under Rescue','Rescued')").n, adopted: q1("SELECT COUNT(*) n FROM stray_animals WHERE Status='Adopted'").n,
  reports: q1('SELECT COUNT(*) n FROM monitoring_reports').n }));

// 2.0 Register Stray Animals (2.1 receive, 2.2 validate, 2.3 save, 2.4 confirmation + records to admin)
R('POST', /^\/api\/animals$/, c => {
  const s = need(c, 'user'), b = c.b;
  const o = { Name: str(b.name, 60) || null, Species: str(b.species, 30) || null, Breed: str(b.breed, 60) || null, Color: str(b.color, 60) || null, Sex: str(b.sex, 10) || null, Photo: b.photo || null };
  if (o.Species && !SPECIES.includes(o.Species)) fail(400, 'Species must be Dog, Cat or Other');
  if (o.Sex && !SEX.includes(o.Sex)) fail(400, 'Sex must be Male, Female or Unknown');
  if (o.Photo && (typeof o.Photo !== 'string' || !/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+\/=]+$/.test(o.Photo) || o.Photo.length > 1.5e6)) fail(400, 'Photo must be a JPG/PNG/WEBP image under about 1 MB');
  const id = newAnimalId();
  run('INSERT INTO stray_animals(AnimalID,Name,Species,Breed,Color,Sex,Photo,RegisterDate,Status,UserID) VALUES(?,?,?,?,?,?,?,?,?,?)', id, o.Name, o.Species, o.Breed, o.Color, o.Sex, o.Photo, today(), 'Stray', s.id);
  return { animalId: id, message: `Registration complete. Animal ID: ${id}` };
});
R('GET', /^\/api\/my\/animals$/, c => q(`SELECT ${PUB} FROM stray_animals WHERE UserID=? ORDER BY RegisterDate DESC`, need(c, 'user').id));
// Admin: Animal Record Management
R('PUT', /^\/api\/admin\/animals\/([\w-]+)$/, c => {
  const s = need(c, 'admin'), b = c.b, a = q1('SELECT * FROM stray_animals WHERE AnimalID=?', c.m[1]);
  if (!a) fail(404, 'Animal record not found');
  if (b.status && !ANIMAL_STATUS.includes(b.status)) fail(400, 'Invalid status');
  if (b.species && !SPECIES.includes(b.species)) fail(400, 'Invalid species');
  if (b.sex && !SEX.includes(b.sex)) fail(400, 'Invalid sex');
  run('UPDATE stray_animals SET Name=?,Species=?,Breed=?,Color=?,Sex=?,Status=?,AdminID=? WHERE AnimalID=?', 'name' in b ? str(b.name, 60) || null : a.Name, 'species' in b ? b.species || null : a.Species, 'breed' in b ? str(b.breed, 60) || null : a.Breed, 'color' in b ? str(b.color, 60) || null : a.Color, 'sex' in b ? b.sex || null : a.Sex, b.status || a.Status, s.id, a.AnimalID);
  return { message: 'Animal record updated' };
});
R('DELETE', /^\/api\/admin\/animals\/([\w-]+)$/, c => { need(c, 'admin'); run('DELETE FROM stray_animals WHERE AnimalID=?', c.m[1]); return { message: 'Animal record deleted' }; });

// 3.0 Monitor Animals (3.1 receive, 3.2 update rescue status, 3.3 record, 3.4 notify)
R('POST', /^\/api\/monitoring$/, c => {
  const s = need(c, 'user'), b = c.b, a = q1('SELECT * FROM stray_animals WHERE AnimalID=?', str(b.animalId, 40));
  if (!a) fail(404, 'No registered animal with that Animal ID');
  if (a.Status === 'Adopted') fail(409, 'This animal has already been adopted');
  const loc = str(b.location, 200), cond = str(b.condition, 500);
  if (!loc && !cond) fail(400, 'Add a location or a condition description');
  run('INSERT INTO monitoring_reports(Date,Location,"Condition",RescueStatus,UserID,AnimalID) VALUES(?,?,?,?,?,?)', today(), loc || null, cond || null, 'Reported', s.id, a.AnimalID);
  return { message: 'Sighting recorded. You can follow rescue updates in your dashboard.' };
});
R('GET', /^\/api\/my\/monitoring$/, c => q('SELECT m.ReportID,m.Date,m.Location,m."Condition",m.RescueStatus,m.AnimalID,a.Name,a.Status AnimalStatus FROM monitoring_reports m JOIN stray_animals a USING(AnimalID) WHERE m.UserID=? ORDER BY m.ReportID DESC', need(c, 'user').id));
R('GET', /^\/api\/admin\/monitoring$/, c => { need(c, 'admin'); return q('SELECT m.ReportID,m.Date,m.Location,m."Condition",m.RescueStatus,m.AnimalID,a.Name,a.Status AnimalStatus,u.FirstName||\' \'||u.LastName Reporter FROM monitoring_reports m JOIN stray_animals a USING(AnimalID) LEFT JOIN users u USING(UserID) ORDER BY m.ReportID DESC'); });
R('PUT', /^\/api\/admin\/monitoring\/(\d+)$/, c => { // Rescue Status Updates from administrators
  const s = need(c, 'admin'), r = q1('SELECT * FROM monitoring_reports WHERE ReportID=?', c.m[1]);
  if (!r) fail(404, 'Report not found');
  if (!RESCUE.includes(c.b.rescueStatus)) fail(400, 'Invalid rescue status');
  tx(() => {
    run('UPDATE monitoring_reports SET RescueStatus=?,AdminID=? WHERE ReportID=?', c.b.rescueStatus, s.id, r.ReportID);
    const a = q1('SELECT Status FROM stray_animals WHERE AnimalID=?', r.AnimalID);
    if (['Stray', 'Under Rescue', 'Rescued'].includes(a.Status) && c.b.rescueStatus !== 'Reported') setAnimal(r.AnimalID, c.b.rescueStatus, s.id);
  });
  return { message: 'Rescue status updated' };
});

R('DELETE', /^\/api\/admin\/monitoring\/(\d+)$/, c => { need(c, 'admin'); if (!run('DELETE FROM monitoring_reports WHERE ReportID=?', c.m[1]).changes) fail(404, 'Report not found'); return { message: 'Monitoring report deleted' }; });

// 5.0 Manage Donations (5.1 receive, 5.2 validate, 5.3 record, 5.4 acknowledgement) — record only, no payment gateway
R('POST', /^\/api\/donations$/, c => {
  const s = need(c, 'user'), amt = Number(c.b.amount), type = c.b.donationType;
  if (!(amt > 0) || amt > 1e7) fail(400, 'Enter a valid donation amount');
  if (!['Cash', 'GCash', 'In-Kind'].includes(type)) fail(400, 'Choose a donation type');
  const key = str(c.b.idempotencyKey, 64) || null, show = c.b.showName === true || c.b.showName === 'on' || c.b.showName === 'true' ? 1 : 0, amount = Math.round(amt * 100) / 100;
  if (key) { // the same form submitted twice (double click, retry) must not create a second record
    const dup = q1('SELECT * FROM donations WHERE UserID=? AND IdempotencyKey=?', s.id, key);
    if (dup) return { donationId: dup.DonationID, amount: dup.Amount, donationType: dup.DonationType, date: dup.DateDonated, acknowledgement: dup.Acknowledgement, verification: dup.VerificationStatus, duplicate: true, message: `Donation #${dup.DonationID} was already recorded. Nothing was added twice.` };
  }
  const r = run('INSERT INTO donations(Amount,DonationType,DateDonated,Acknowledgement,UserID,VerificationStatus,ShowName,IdempotencyKey) VALUES(?,?,?,?,?,?,?,?)', amount, type, today(), 'Acknowledged', s.id, 'Pending', show, key);
  return { donationId: Number(r.lastInsertRowid), amount, donationType: type, date: today(), acknowledgement: 'Acknowledged', verification: 'Pending', message: `Thank you! Donation #${r.lastInsertRowid} (${type}, ₱${amount.toFixed(2)}) has been recorded and acknowledged. It will appear in the public transparency totals once the administrators verify that it was received.` };
});
R('GET', /^\/api\/my\/donations$/, c => q('SELECT * FROM donations WHERE UserID=? ORDER BY DonationID DESC', need(c, 'user').id));

// 6.0 Process Adoptions (6.1 receive, 6.2 check availability, 6.3 admin review, 6.4 record, 6.5 notify)
R('POST', /^\/api\/adoptions$/, c => {
  const s = need(c, 'adopter'), a = q1('SELECT * FROM stray_animals WHERE AnimalID=?', str(c.b.animalId, 40));
  if (!a) fail(404, 'Animal not found');
  if (a.Status !== 'Available for Adoption') fail(409, `This animal is not available for adoption (status: ${a.Status})`);
  tx(() => { run('INSERT INTO adoptions(RequestDate,AdoptionStatus,AdopterID,AnimalID) VALUES(?,?,?,?)', today(), 'Pending', s.id, a.AnimalID); setAnimal(a.AnimalID, 'Pending Adoption'); });
  return { message: 'Adoption request sent. The Barangay Tinurik administrators will review it.' };
});
R('GET', /^\/api\/my\/adoptions$/, c => q('SELECT d.*,a.Name,a.Species FROM adoptions d JOIN stray_animals a USING(AnimalID) WHERE d.AdopterID=? ORDER BY d.AdoptionID DESC', need(c, 'adopter').id));
R('GET', /^\/api\/admin\/adoptions$/, c => { need(c, 'admin'); return q("SELECT d.*,a.Name,a.Species,p.FirstName||' '||p.LastName Adopter,p.Email,p.PhoneNo FROM adoptions d JOIN stray_animals a USING(AnimalID) JOIN adopters p USING(AdopterID) ORDER BY d.AdoptionID DESC"); });
R('PUT', /^\/api\/admin\/adoptions\/(\d+)$/, c => { // Adoption Decision
  const s = need(c, 'admin'), d = q1('SELECT * FROM adoptions WHERE AdoptionID=?', c.m[1]), dec = c.b.decision;
  if (!d) fail(404, 'Adoption request not found');
  if (d.AdoptionStatus !== 'Pending') fail(409, 'This request was already decided');
  if (!['Approved', 'Rejected'].includes(dec)) fail(400, 'Decision must be Approved or Rejected');
  tx(() => { run('UPDATE adoptions SET AdoptionStatus=?,DecisionDate=?,AdminID=? WHERE AdoptionID=?', dec, today(), s.id, d.AdoptionID); setAnimal(d.AnimalID, dec === 'Approved' ? 'Adopted' : 'Available for Adoption', s.id); });
  return { message: `Adoption request ${dec.toLowerCase()}` };
});

// 1.0 admin side: account records
R('GET', /^\/api\/admin\/accounts$/, c => { need(c, 'admin'); return { users: q('SELECT UserID,FirstName,LastName,Email,PhoneNo,Address,Role,AccountStatus FROM users ORDER BY UserID DESC'), adopters: q('SELECT AdopterID,FirstName,LastName,Email,PhoneNo,Address,AccountStatus FROM adopters ORDER BY AdopterID DESC') }; });
R('PUT', /^\/api\/admin\/accounts\/(user|adopter)\/(\d+)$/, c => {
  const s = need(c, 'admin'), st = c.b.accountStatus;
  if (!['Active', 'Suspended'].includes(st)) fail(400, 'Status must be Active or Suspended');
  const r = c.m[1] === 'user' ? run('UPDATE users SET AccountStatus=?,AdminID=? WHERE UserID=?', st, s.id, c.m[2]) : run('UPDATE adopters SET AccountStatus=?,AdminID=? WHERE AdopterID=?', st, s.id, c.m[2]);
  if (!r.changes) fail(404, 'Account not found');
  return { message: 'Account status updated' };
});

// 7.0 Generate Reports and Information (7.1 receive request, 7.2 gather, 7.3 generate -> D6)
R('POST', /^\/api\/admin\/system-reports$/, c => {
  const s = need(c, 'admin'), type = c.b.reportType;
  if (!['Animals', 'Monitoring', 'Donations', 'Adoptions', 'Full'].includes(type)) fail(400, 'Choose a report type');
  const all = type === 'Full', data = {};
  if (all || type === 'Animals') data.animals = q('SELECT AnimalID,Name,Species,Breed,Color,Sex,RegisterDate,Status FROM stray_animals ORDER BY RegisterDate DESC');
  if (all || type === 'Monitoring') data.monitoring = q('SELECT ReportID,Date,AnimalID,Location,"Condition",RescueStatus FROM monitoring_reports ORDER BY ReportID DESC');
  if (all || type === 'Donations') data.donations = q('SELECT DonationID,Amount,DonationType,DateDonated,Acknowledgement,VerificationStatus,UserID FROM donations ORDER BY DonationID DESC');
  if (all || type === 'Adoptions') data.adoptions = q('SELECT AdoptionID,AnimalID,AdopterID,RequestDate,AdoptionStatus,DecisionDate FROM adoptions ORDER BY AdoptionID DESC');
  const summary = {};
  if (data.animals) q('SELECT Status,COUNT(*) n FROM stray_animals GROUP BY Status').forEach(r => summary['Animals: ' + r.Status] = r.n);
  if (data.monitoring) summary['Monitoring reports'] = data.monitoring.length;
  if (data.donations) { // same rule as the public Transparency page: only verified cash/GCash counts as received funds
    const fundC = data.donations.filter(d => d.VerificationStatus === 'Verified' && d.DonationType !== 'In-Kind').reduce((t, d) => t + Math.round(d.Amount * 100), 0);
    summary['Donations recorded'] = data.donations.length; summary['Verified cash/GCash donations (₱)'] = fundC / 100; summary['Donations awaiting verification'] = data.donations.filter(d => d.VerificationStatus === 'Pending').length;
  }
  if (data.adoptions) q('SELECT AdoptionStatus,COUNT(*) n FROM adoptions GROUP BY AdoptionStatus').forEach(r => summary['Adoptions: ' + r.AdoptionStatus] = r.n);
  const publicAnimals = q("SELECT AnimalID,Name,Species,Breed,Status FROM stray_animals WHERE Status='Available for Adoption'");
  const id = tx(() => {
    const r = run('INSERT INTO system_reports(ReportType,PublicInformation,ReportDate,AdminID) VALUES(?,?,?,?)', type, JSON.stringify({ summary, publicAnimals, data }), today(), s.id);
    (data.donations || []).forEach(d => run('INSERT OR IGNORE INTO donation_audits(DonationID,ReportID) VALUES(?,?)', d.DonationID, r.lastInsertRowid));
    return r.lastInsertRowid;
  });
  return { reportId: id, message: `${type} report #${id} generated` };
});
R('GET', /^\/api\/admin\/system-reports$/, c => { need(c, 'admin'); return q('SELECT * FROM system_reports ORDER BY ReportID DESC LIMIT 30').map(r => ({ ...r, PublicInformation: JSON.parse(r.PublicInformation || '{}') })); });

R('DELETE', /^\/api\/admin\/system-reports\/(\d+)$/, c => { need(c, 'admin'); if (!run('DELETE FROM system_reports WHERE ReportID=?', c.m[1]).changes) fail(404, 'Report not found'); return { message: 'Report deleted' }; });

// Donation Transparency System (public transparency page + admin finance tools) lives in transparency.js
require('./transparency')({ db, q, q1, run, tx, fail, str, today, need, R });

// ---------- server
const MIME = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.ico': 'image/x-icon' };
const readBody = req => new Promise((ok, no) => { let d = '', n = 0; req.on('data', x => { n += x.length; if (n > 3e6) { no({ code: 413, msg: 'Payload too large' }); req.destroy(); } else d += x; }); req.on('end', () => { try { ok(d ? JSON.parse(d) : {}); } catch { no({ code: 400, msg: 'Invalid JSON' }); } }); });
const send = (res, code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  try {
    if (url.pathname.startsWith('/api/')) {
      const token = (req.headers.authorization || '').replace('Bearer ', '');
      for (const [m, re, f] of routes) {
        const mm = m === req.method && url.pathname.match(re);
        if (!mm) continue;
        const c = { req, url, m: mm, token, s: sessions.get(token), b: ['POST', 'PUT'].includes(m) ? await readBody(req) : {} };
        const out = f(c);
        if (out && out.__raw) { res.writeHead(200, out.__raw.headers); return res.end(out.__raw.body); }
        return send(res, 200, out);
      }
      return send(res, 404, { error: 'Not found' });
    }
    let f = path.normalize(path.join(__dirname, 'public', url.pathname === '/' ? 'index.html' : url.pathname));
    if (!f.startsWith(path.join(__dirname, 'public')) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) f = path.join(__dirname, 'public', 'index.html');
    res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream' });
    fs.createReadStream(f).pipe(res);
  } catch (e) {
    if (e && e.code) return send(res, e.code, { error: e.msg });
    console.error(e); send(res, 500, { error: 'Server error' });
  }
}).listen(PORT, () => console.log(`PurrID running at http://localhost:${PORT}  (admin login: "admin")`));
