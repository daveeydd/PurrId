# PurrID – Barangay Tinurik, Tanauan City, Batangas

## Run
Requires **Node.js 22.5+** (uses built-in `node:sqlite`; no `npm install` needed).

    node server.js          # then open http://localhost:3000

Admin login: credentials `admin` / password `admin123`
(set your own with `ADMIN_PASSWORD=yourpass node server.js` before the FIRST run; the database is `purrid.db`).

## DFD -> code map
| DFD process | Where |
|---|---|
| 1.0 Manage Accounts (1.1-1.4) | `POST /api/register`, `/api/login`, admin Accounts tab |
| 2.0 Register Stray Animals (2.1-2.4) | `POST /api/animals`, Admin "Animal records" tab (Animal Record Management) |
| 3.0 Monitor Animals (3.1-3.4) | `POST /api/monitoring`, `PUT /api/admin/monitoring/:id` (Rescue Status Updates), user Dashboard |
| 4.0 Search Animal Records (4.1-4.3) | `GET /api/animals?q=` searches D2 + D3 |
| 5.0 Manage Donations (5.1-5.4) | `POST /api/donations` |
| 6.0 Process Adoptions (6.1-6.5) | `POST /api/adoptions`, `PUT /api/admin/adoptions/:id` |
| 7.0 Generate Reports and Information (7.1-7.4) | `POST/GET /api/admin/system-reports`, `GET /api/public`, public animal pages |

## ERD -> tables
admins, users, adopters, stray_animals, monitoring_reports, adoptions, donations, system_reports
(+ `donation_audits` to realise the many-to-many "Audits" relationship between Donations and System Reports).
Added per your decisions: Password on User and Adopters; Animal Name/Sex; animal details optional.

## Donation Transparency System (added)
Public page: `#/transparency` ("Transparency" in the menu). Admin: **Admin Panel → Donations & funds**.

**How the numbers work (all calculated on the server from the database, never hard-coded):**
`Remaining balance = verified Cash/GCash donations − active (non-voided) expenses`
* New donations start as **Pending**. An administrator must **Verify** them (after confirming the money was received). Pending, Rejected and Cancelled donations are never counted.
* **In-Kind** donations are listed but are not cash, so they are not counted in the balance.
* Money is summed in whole centavos (no rounding drift). Reports use the same functions as the dashboard.
* Donations that existed before this feature are kept untouched and show as **Pending** until verified.

**Privacy:** donors are anonymous by default; they can tick "show my first name and last initial" on the Donate page. Emails, phone numbers, user IDs and full names are never returned by public endpoints.

**Integrity:** expenses are never deleted (they are *voided* with a reason). Corrections to donations/expenses need a reason, and the old values go to `financial_audit_log`, which the database itself refuses to edit or delete. A double-clicked/retried donation form is recorded once (idempotency key).

**Receipts:** JPG/PNG/WEBP/PDF up to 2 MB, content type checked by file signature, stored inside the database (no public file folder). Receipts are **private by default**; an admin must tick that private details were removed before one becomes public.

**Reports:** Admin → Donations & funds → Reports: choose a period, preview, download **CSV**, or **Print / Save as PDF** (opening balance, donations, expenses, category breakdown, closing balance, notes, receipt counts).

| Area | Where |
|---|---|
| Public API | `GET /api/transparency/{summary,donations,expenses,updates}`, `GET /api/transparency/receipts/:id` (public receipts only) |
| Admin API | `/api/admin/finance/*` (overview, donations, expenses, receipts, updates, audit, report) — admin login required |
| Server code | `transparency.js` (installed from `server.js`) |
| Browser code | `public/transparency.js` |
| New tables | `expenses`, `expense_receipts`, `transparency_updates`, `financial_audit_log`; new columns on `donations` (`VerificationStatus`, `VerifiedBy`, `VerifiedAt`, `ShowName`, `IdempotencyKey`) |
| Tests | `node tests/transparency.test.js` (uses a temporary copy of the database) |

Note: on Render's free plan the disk is erased on redeploy, which also erases `purrid.db`. Financial records need a persistent disk or regular backups.
