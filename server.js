// Green Meadows Society Manager - backend (Express + PostgreSQL)
const express = require('express'), { Pool, types } = require('pg'), jwt = require('jsonwebtoken');
const fs = require('fs'), path = require('path');

// Return dates as plain strings and numbers as JS numbers
types.setTypeParser(1082, v => v); types.setTypeParser(1114, v => v);
types.setTypeParser(1700, parseFloat); types.setTypeParser(20, parseInt);

const url = process.env.DATABASE_URL || 'postgres://localhost:5432/society';
const pool = new Pool({ connectionString: url, ssl: /localhost|127\.0\.0\.1/.test(url) ? false : { rejectUnauthorized: false } });
const q = (s, p) => pool.query(s, p).then(r => r.rows);
const SECRET = process.env.JWT_SECRET || 'dev-secret-change-me';
const PINS = { Secretary: process.env.SECRETARY_PIN || '1111', Treasurer: process.env.TREASURER_PIN || '2222',
               Security: process.env.SECURITY_PIN || '3333', Resident: process.env.RESIDENT_PIN || '4444' };

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
const wrap = f => (req, res) => f(req, res).catch(e => { console.error(e); res.status(500).json({ error: e.message }); });
const auth = (...roles) => (req, res, next) => {
  try {
    const u = jwt.verify((req.headers.authorization || '').slice(7), SECRET);
    if (roles.length && !roles.includes(u.role)) return res.status(403).json({ error: 'Not allowed for your role' });
    req.user = u; next();
  } catch (e) { res.status(401).json({ error: 'Please sign in' }); }
};
const tx = async fn => {
  const c = await pool.connect();
  try { await c.query('BEGIN'); const r = await fn(c); await c.query('COMMIT'); return r; }
  catch (e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); }
};
const occ = (a, c = pool) => c.query("SELECT resident_id FROM occupancy WHERE apartment_id=$1 AND end_date IS NULL ORDER BY (type='tenant') DESC LIMIT 1", [a]).then(r => r.rows[0] && r.rows[0].resident_id);
const scope = u => u.role === 'Resident' ? u.apartment_id : null;   // residents only see their own flat

// ---------- Auth ----------
app.get('/api/public/apartments', wrap(async (req, res) =>
  res.json(await q('SELECT a.apartment_id, b.name AS building, a.unit_number FROM apartment a JOIN building b USING(building_id) ORDER BY b.name, a.floor, a.unit_number'))));

app.post('/api/login', wrap(async (req, res) => {
  const { role, pin, apartment_id } = req.body;
  if (!PINS[role] || pin !== PINS[role]) return res.status(401).json({ error: 'Wrong role or PIN' });
  const user = { role, apartment_id: null, label: null };
  if (role === 'Resident') {
    const r = await q("SELECT b.name || ' ' || a.unit_number AS label FROM apartment a JOIN building b USING(building_id) WHERE a.apartment_id=$1", [apartment_id]);
    if (!r.length) return res.status(400).json({ error: 'Choose your flat' });
    user.apartment_id = +apartment_id; user.label = r[0].label;
  }
  res.json({ token: jwt.sign(user, SECRET, { expiresIn: '12h' }), user });
}));

// ---------- Dashboard ----------
app.get('/api/dashboard', auth('Secretary', 'Treasurer'), wrap(async (req, res) => {
  const [s] = await q(`SELECT (SELECT COUNT(*) FROM apartment)::int AS flats, (SELECT COUNT(*) FROM staff)::int AS staff,
    (SELECT COUNT(*) FROM service_request WHERE status<>'Resolved')::int AS open_requests,
    (SELECT COUNT(*) FROM visit_log WHERE check_out IS NULL)::int AS visitors_inside,
    (SELECT COALESCE(SUM(total_amount),0) FROM maintenance_bill WHERE status='Unpaid') AS dues_pending,
    (SELECT COALESCE(SUM(amount_paid),0) FROM payment) AS collected`);
  s.monthly = await q(`SELECT billing_month, SUM(total_amount) AS billed,
    SUM(CASE WHEN status='Paid' THEN total_amount ELSE 0 END) AS collected FROM maintenance_bill GROUP BY billing_month ORDER BY billing_month`);
  res.json(s);
}));

// ---------- Buildings and flats ----------
app.get('/api/buildings', auth('Secretary'), wrap(async (req, res) => res.json(await q('SELECT * FROM building ORDER BY name'))));

app.get('/api/apartments', auth('Secretary', 'Treasurer', 'Security'), wrap(async (req, res) => {
  const rows = await q(`SELECT a.apartment_id, b.name AS building, a.unit_number, a.floor, a.area_sqft,
    (SELECT r.full_name FROM occupancy o JOIN resident r USING(resident_id) WHERE o.apartment_id=a.apartment_id AND o.type='owner' AND o.end_date IS NULL LIMIT 1) AS owner,
    (SELECT r.phone FROM occupancy o JOIN resident r USING(resident_id) WHERE o.apartment_id=a.apartment_id AND o.type='owner' AND o.end_date IS NULL LIMIT 1) AS phone,
    (SELECT r.full_name || ' (' || o.type || ')' FROM occupancy o JOIN resident r USING(resident_id) WHERE o.apartment_id=a.apartment_id AND o.end_date IS NULL ORDER BY (o.type='tenant') DESC LIMIT 1) AS lives,
    COALESCE(d.n,0) AS months_unpaid, COALESCE(d.t,0) AS total_due
    FROM apartment a JOIN building b USING(building_id)
    LEFT JOIN (SELECT apartment_id, COUNT(*)::int AS n, SUM(total_amount) AS t FROM maintenance_bill WHERE status='Unpaid' GROUP BY apartment_id) d USING(apartment_id)
    ORDER BY b.name, a.floor, a.unit_number`);
  if (req.user.role === 'Security') rows.forEach(r => { r.months_unpaid = null; r.total_due = null; });  // guards do not see dues
  res.json(rows);
}));

app.post('/api/apartments', auth('Secretary'), wrap(async (req, res) => {
  const b = req.body, unit = String(b.unit_number);
  res.json(await tx(async c => {
    const a = (await c.query('INSERT INTO apartment(building_id,unit_number,floor,area_sqft,type) VALUES($1,$2,$3,$4,$5) RETURNING apartment_id',
      [b.building_id, unit, b.floor || Math.floor(unit / 100), b.area_sqft, b.area_sqft >= 950 ? '3 BHK' : '2 BHK'])).rows[0].apartment_id;
    const mk = async (name, type) => {
      const r = (await c.query('INSERT INTO resident(full_name,phone) VALUES($1,$2) RETURNING resident_id', [name, b.phone])).rows[0].resident_id;
      await c.query('INSERT INTO occupancy(apartment_id,resident_id,type,start_date) VALUES($1,$2,$3,CURRENT_DATE)', [a, r, type]);
    };
    await mk(b.owner_name, 'owner');
    if (b.tenant_name) await mk(b.tenant_name, 'tenant');
    return { apartment_id: a };
  }));
}));

app.delete('/api/apartments/:id', auth('Secretary'), wrap(async (req, res) => {
  const id = +req.params.id;
  await tx(async c => {
    await c.query('DELETE FROM payment WHERE bill_id IN (SELECT bill_id FROM maintenance_bill WHERE apartment_id=$1)', [id]);
    for (const t of ['maintenance_bill', 'visit_log', 'service_request', 'occupancy', 'apartment']) await c.query(`DELETE FROM ${t} WHERE apartment_id=$1`, [id]);
  });
  res.json({ ok: true });
}));

// ---------- Staff ----------
app.get('/api/staff', auth('Secretary', 'Treasurer', 'Security'), wrap(async (req, res) =>
  res.json(await q(`SELECT s.*, (SELECT COUNT(*) FROM service_request r WHERE r.staff_id=s.staff_id AND r.status<>'Resolved')::int AS open_tasks FROM staff s ORDER BY s.role, s.name`))));
app.post('/api/staff', auth('Secretary'), wrap(async (req, res) => {
  const { name, role, phone } = req.body;
  res.json((await q('INSERT INTO staff(name,role,phone,joined_on) VALUES($1,$2,$3,CURRENT_DATE) RETURNING *', [name, role, phone]))[0]);
}));
app.delete('/api/staff/:id', auth('Secretary'), wrap(async (req, res) => {
  await tx(async c => {
    await c.query("UPDATE service_request SET staff_id=NULL, status=CASE WHEN status='In progress' THEN 'Open' ELSE status END WHERE staff_id=$1", [req.params.id]);
    await c.query('UPDATE visit_log SET staff_id=NULL WHERE staff_id=$1', [req.params.id]);
    await c.query('DELETE FROM staff WHERE staff_id=$1', [req.params.id]);
  });
  res.json({ ok: true });
}));

// ---------- Service requests ----------
app.get('/api/requests', auth('Secretary', 'Resident'), wrap(async (req, res) =>
  res.json(await q(`SELECT sr.request_id, b.name AS building, a.unit_number, sr.category, sr.description, sr.status, sr.raised_at, sr.staff_id, s.name AS assigned_to
    FROM service_request sr JOIN apartment a USING(apartment_id) JOIN building b USING(building_id) LEFT JOIN staff s USING(staff_id)
    WHERE ($1::int IS NULL OR sr.apartment_id=$1) ORDER BY (sr.status='Resolved'), sr.raised_at DESC LIMIT 300`, [scope(req.user)]))));

app.post('/api/requests', auth('Secretary', 'Resident'), wrap(async (req, res) => {
  const apt = req.user.role === 'Resident' ? req.user.apartment_id : +req.body.apartment_id;
  const staff = req.body.staff_id ? +req.body.staff_id : null;
  res.json((await q('INSERT INTO service_request(apartment_id,resident_id,staff_id,category,description,status,raised_at) VALUES($1,$2,$3,$4,$5,$6,NOW()) RETURNING *',
    [apt, await occ(apt), staff, req.body.category, req.body.description, staff ? 'In progress' : 'Open']))[0]);
}));

app.patch('/api/requests/:id', auth('Secretary'), wrap(async (req, res) => {
  const { staff_id, status } = req.body;
  if (status === 'Resolved') await q("UPDATE service_request SET status='Resolved', resolved_at=NOW() WHERE request_id=$1", [req.params.id]);
  else await q("UPDATE service_request SET staff_id=$2, status=CASE WHEN $2::int IS NULL THEN 'Open' ELSE 'In progress' END WHERE request_id=$1 AND status<>'Resolved'", [req.params.id, staff_id || null]);
  res.json({ ok: true });
}));

// ---------- Maintenance bills ----------
app.get('/api/bills', auth('Secretary', 'Treasurer', 'Resident'), wrap(async (req, res) =>
  res.json(await q(`SELECT m.bill_id, m.billing_month, b.name AS building, a.unit_number, m.apartment_id, m.base_amount, m.late_fee, m.total_amount, m.due_date, m.status,
    (SELECT r.full_name FROM occupancy o JOIN resident r USING(resident_id) WHERE o.apartment_id=a.apartment_id AND o.type='owner' AND o.end_date IS NULL LIMIT 1) AS owner
    FROM maintenance_bill m JOIN apartment a USING(apartment_id) JOIN building b USING(building_id)
    WHERE ($1::int IS NULL OR m.apartment_id=$1) AND ($2::text IS NULL OR m.status=$2)
    ORDER BY m.billing_month DESC, b.name, a.unit_number LIMIT 400`, [scope(req.user), req.query.status || null]))));

// Generate bills for a month. Unpaid earlier months add a late fee and stay on the account.
app.post('/api/bills/generate', auth('Treasurer'), wrap(async (req, res) => {
  const { month, rate, late_fee } = req.body;
  const r = await pool.query(`INSERT INTO maintenance_bill(apartment_id,billing_month,base_amount,late_fee,total_amount,due_date,status)
    SELECT a.apartment_id, $1::char(7), ROUND(a.area_sqft*$2::numeric), p.n*$3::numeric, ROUND(a.area_sqft*$2::numeric)+p.n*$3::numeric, ($1 || '-10')::date, 'Unpaid'
    FROM apartment a
    CROSS JOIN LATERAL (SELECT COUNT(*)::int AS n FROM maintenance_bill m WHERE m.apartment_id=a.apartment_id AND m.status='Unpaid' AND m.billing_month < $1::char(7)) p
    WHERE NOT EXISTS (SELECT 1 FROM maintenance_bill m WHERE m.apartment_id=a.apartment_id AND m.billing_month=$1::char(7))`, [month, rate, late_fee || 0]);
  res.json({ created: r.rowCount });
}));

const payBill = async (c, id) => {
  const b = (await c.query("UPDATE maintenance_bill SET status='Paid' WHERE bill_id=$1 AND status='Unpaid' RETURNING apartment_id, total_amount", [id])).rows[0];
  if (!b) return 0;
  await c.query("INSERT INTO payment(bill_id,resident_id,amount_paid,paid_on,mode) VALUES($1,$2,$3,CURRENT_DATE,'UPI')", [id, await occ(b.apartment_id, c), b.total_amount]);
  return 1;
};
app.post('/api/bills/:id/pay', auth('Treasurer', 'Resident'), wrap(async (req, res) => {
  const [b] = await q('SELECT apartment_id FROM maintenance_bill WHERE bill_id=$1', [req.params.id]);
  if (!b || (req.user.role === 'Resident' && b.apartment_id !== req.user.apartment_id)) return res.status(403).json({ error: 'Not your bill' });
  res.json({ paid: await tx(c => payBill(c, req.params.id)) });
}));
app.post('/api/apartments/:id/pay-all', auth('Treasurer', 'Resident'), wrap(async (req, res) => {
  const id = +req.params.id;
  if (req.user.role === 'Resident' && id !== req.user.apartment_id) return res.status(403).json({ error: 'Not your flat' });
  res.json({ paid: await tx(async c => {
    let n = 0;
    for (const b of (await c.query("SELECT bill_id FROM maintenance_bill WHERE apartment_id=$1 AND status='Unpaid'", [id])).rows) n += await payBill(c, b.bill_id);
    return n;
  }) });
}));

// ---------- Visitors / security gate ----------
app.get('/api/visits', auth('Secretary', 'Security', 'Resident'), wrap(async (req, res) =>
  res.json(await q(`SELECT vl.visit_id, v.name AS visitor, v.phone, b.name AS building, a.unit_number, vl.purpose, g.name AS guard, vl.check_in, vl.check_out
    FROM visit_log vl JOIN visitor v USING(visitor_id) JOIN apartment a USING(apartment_id) JOIN building b USING(building_id) LEFT JOIN staff g USING(staff_id)
    WHERE ($1::int IS NULL OR vl.apartment_id=$1) ORDER BY vl.check_in DESC LIMIT 200`, [scope(req.user)]))));

app.post('/api/visits', auth('Security'), wrap(async (req, res) => {
  const b = req.body;
  res.json(await tx(async c => {
    let v = (await c.query('SELECT visitor_id FROM visitor WHERE phone=$1 LIMIT 1', [b.phone])).rows[0];
    if (!v) v = (await c.query('INSERT INTO visitor(name,phone,id_proof_type,id_last4) VALUES($1,$2,$3,$4) RETURNING visitor_id', [b.name, b.phone, b.id_proof_type || 'Aadhaar', b.id_last4 || null])).rows[0];
    return (await c.query('INSERT INTO visit_log(visitor_id,apartment_id,staff_id,purpose,check_in) VALUES($1,$2,$3,$4,NOW()) RETURNING *', [v.visitor_id, b.apartment_id, b.staff_id || null, b.purpose])).rows[0];
  }));
}));
app.patch('/api/visits/:id/checkout', auth('Security'), wrap(async (req, res) => {
  await q('UPDATE visit_log SET check_out=NOW() WHERE visit_id=$1 AND check_out IS NULL', [req.params.id]);
  res.json({ ok: true });
}));

// ---------- Start: create tables and load sample data on first run ----------
const IDS = { building: 'building_id', apartment: 'apartment_id', resident: 'resident_id', occupancy: 'occupancy_id', staff: 'staff_id',
  service_request: 'request_id', maintenance_bill: 'bill_id', payment: 'payment_id', visitor: 'visitor_id', visit_log: 'visit_id' };
async function init() {
  const has = await q("SELECT to_regclass('public.building') AS t");
  if (!has[0].t) { await pool.query(fs.readFileSync(path.join(__dirname, 'society_dataset.sql'), 'utf8')); console.log('Database created and seeded'); }
  for (const [t, c] of Object.entries(IDS)) {   // auto-increment ids for new rows
    await pool.query(`CREATE SEQUENCE IF NOT EXISTS ${t}_seq`);
    await pool.query(`SELECT setval('${t}_seq', (SELECT COALESCE(MAX(${c}),0)+1 FROM ${t}), false)`);
    await pool.query(`ALTER TABLE ${t} ALTER COLUMN ${c} SET DEFAULT nextval('${t}_seq')`);
  }
}
const PORT = process.env.PORT || 3000;
init().then(() => app.listen(PORT, () => console.log('Society app running on port ' + PORT))).catch(e => { console.error(e); process.exit(1); });
