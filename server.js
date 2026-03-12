/**
 * ═══════════════════════════════════════════════════════════════
 * SILICON BAYOU HOLDINGS — AI SaaS Founder Pro Forma Portal
 * Discovery, Data Collection & Financial Model Generation
 * ═══════════════════════════════════════════════════════════════
 */

const express = require('express');
const Database = require('better-sqlite3');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 4001;
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'becky@siliconbayou.ai';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '1234';

app.use(cors());
app.use(express.json({ limit: '5mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ─── Database ────────────────────────────────────────────
const dataDir = process.env.RAILWAY_VOLUME_MOUNT_PATH || path.join(__dirname, 'data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
const dbPath = path.join(dataDir, 'proforma.db');
const db = new Database(dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS founders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT UNIQUE NOT NULL,
    name TEXT NOT NULL,
    company_name TEXT NOT NULL,
    phase TEXT DEFAULT 'idea',
    vertical TEXT DEFAULT 'General B2B SaaS',
    customer_type TEXT DEFAULT 'B2B - SMB',
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS intake_responses (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    founder_id INTEGER NOT NULL,
    module_number INTEGER NOT NULL,
    question_number INTEGER NOT NULL,
    response_value TEXT,
    response_type TEXT DEFAULT 'founder_provided',
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (founder_id) REFERENCES founders(id),
    UNIQUE(founder_id, module_number, question_number)
  );

  CREATE TABLE IF NOT EXISTS financial_models (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    founder_id INTEGER NOT NULL,
    model_json TEXT NOT NULL,
    finance_score INTEGER,
    generated_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (founder_id) REFERENCES founders(id)
  );

  CREATE TABLE IF NOT EXISTS audit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    action TEXT NOT NULL,
    detail TEXT,
    ip_address TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );
`);

// Migrations
try { db.exec("ALTER TABLE financial_models ADD COLUMN follow_up_sent INTEGER DEFAULT 0"); } catch(e) {}
try { db.exec("ALTER TABLE financial_models ADD COLUMN confirmation_sent INTEGER DEFAULT 0"); } catch(e) {}

console.log('✓ Database connected:', dbPath);

// ─── Email ───────────────────────────────────────────────
let transporter = null;
try {
  if (process.env.EMAIL_USER && process.env.EMAIL_PASSWORD) {
    const nodemailer = require('nodemailer');
    transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST || 'smtp.gmail.com',
      port: parseInt(process.env.SMTP_PORT) || 587,
      secure: false,
      auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASSWORD }
    });
    console.log('✓ Email configured:', process.env.EMAIL_USER);
  } else {
    console.log('⚠ Email not configured');
  }
} catch (e) {
  console.log('⚠ Email error:', e.message);
}

// ─── Auth ────────────────────────────────────────────────
function authenticateAdmin(req, res, next) {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'No token' });
  const expected = Buffer.from(`${ADMIN_EMAIL}:${ADMIN_PASSWORD}`).toString('base64');
  if (token === expected) return next();
  return res.status(401).json({ error: 'Unauthorized' });
}

// ═══════════════════════════════════════════════════════════
// BENCHMARK DEFAULTS (from SaaStr, Bessemer, OpenView, PitchBook 2024)
// ═══════════════════════════════════════════════════════════
const BENCHMARKS = {
  idea:     { mrr_growth: 0, gross_margin: 70, churn: 8, cac: 100, acv: 1200, burn: 8000, team: 2, raise: 250000, valuation: 2000000 },
  pre_seed: { mrr_growth: 15, gross_margin: 70, churn: 6, cac: 200, acv: 2400, burn: 15000, team: 4, raise: 500000, valuation: 4000000 },
  seed:     { mrr_growth: 12, gross_margin: 72, churn: 5, cac: 350, acv: 6000, burn: 40000, team: 10, raise: 2000000, valuation: 10000000 },
  series_a: { mrr_growth: 10, gross_margin: 75, churn: 3, cac: 500, acv: 12000, burn: 100000, team: 25, raise: 8000000, valuation: 40000000 },
};

// ═══════════════════════════════════════════════════════════
// FOUNDER API
// ═══════════════════════════════════════════════════════════

// POST /api/founders — Register / start intake
app.post('/api/founders', (req, res) => {
  const { email, name, company_name } = req.body;
  if (!email || !name || !company_name) return res.status(400).json({ error: 'Name, email, company required' });

  try {
    const existing = db.prepare('SELECT id FROM founders WHERE email = ?').get(email);
    if (existing) {
      db.prepare('UPDATE founders SET name=?, company_name=?, updated_at=datetime("now") WHERE email=?').run(name, company_name, email);
      return res.json({ success: true, founder_id: existing.id, existing: true });
    }
    const result = db.prepare('INSERT INTO founders (email, name, company_name) VALUES (?, ?, ?)').run(email, name, company_name);
    db.prepare('INSERT INTO audit_log (action, detail, ip_address) VALUES (?, ?, ?)').run('FOUNDER_REGISTERED', `${name} (${company_name}) — ${email}`, req.ip);
    res.json({ success: true, founder_id: result.lastInsertRowid });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/responses — Save a single intake response
app.post('/api/responses', (req, res) => {
  const { founder_id, module_number, question_number, response_value, response_type } = req.body;
  if (!founder_id || !module_number || !question_number) return res.status(400).json({ error: 'Missing fields' });

  try {
    db.prepare(`
      INSERT INTO intake_responses (founder_id, module_number, question_number, response_value, response_type)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(founder_id, module_number, question_number)
      DO UPDATE SET response_value=excluded.response_value, response_type=excluded.response_type, updated_at=datetime('now')
    `).run(founder_id, module_number, question_number, response_value || '', response_type || 'founder_provided');

    // Update founder phase/vertical if relevant questions
    if (module_number === 1 && question_number === 5) {
      const phaseMap = { 'Idea': 'idea', 'Pre-Seed': 'pre_seed', 'Seed': 'seed', 'Series A+': 'series_a' };
      db.prepare('UPDATE founders SET phase=?, updated_at=datetime("now") WHERE id=?').run(phaseMap[response_value] || 'idea', founder_id);
    }
    if (module_number === 1 && question_number === 2) {
      db.prepare('UPDATE founders SET vertical=?, updated_at=datetime("now") WHERE id=?').run(response_value, founder_id);
    }
    if (module_number === 1 && question_number === 3) {
      db.prepare('UPDATE founders SET customer_type=?, updated_at=datetime("now") WHERE id=?').run(response_value, founder_id);
    }

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/responses/:founder_id — Get all responses
app.get('/api/responses/:founder_id', (req, res) => {
  const rows = db.prepare('SELECT module_number, question_number, response_value, response_type FROM intake_responses WHERE founder_id = ?').all(req.params.founder_id);
  const responses = {};
  rows.forEach(r => { responses[`${r.module_number}_${r.question_number}`] = { value: r.response_value, type: r.response_type }; });
  res.json({ responses });
});

// POST /api/generate-model/:founder_id — Generate 5-year financial model
app.post('/api/generate-model/:founder_id', (req, res) => {
  const fid = req.params.founder_id;
  const founder = db.prepare('SELECT * FROM founders WHERE id = ?').get(fid);
  if (!founder) return res.status(404).json({ error: 'Founder not found' });

  const rows = db.prepare('SELECT module_number, question_number, response_value FROM intake_responses WHERE founder_id = ?').all(fid);
  const answers = {};
  rows.forEach(r => { answers[`${r.module_number}_${r.question_number}`] = r.response_value; });

  try {
    const model = generateFinancialModel(founder, answers);
    db.prepare(`
      INSERT INTO financial_models (founder_id, model_json, finance_score)
      VALUES (?, ?, ?)
    `).run(fid, JSON.stringify(model), model.finance_score?.score || 0);

    db.prepare('INSERT INTO audit_log (action, detail) VALUES (?, ?)').run('MODEL_GENERATED', `${founder.company_name} (ID:${fid}) — Score: ${model.finance_score?.score || 0}/5`);

    // Notify admin + send confirmation to founder
    if (transporter) {
      sendAdminNotification(founder, model).catch(e => console.error('Admin email error:', e.message));
      sendFounderConfirmation(founder, model).catch(e => console.error('Confirmation email error:', e.message));
    }

    res.json({ success: true, model });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/model/:founder_id — Get latest model
app.get('/api/model/:founder_id', (req, res) => {
  const row = db.prepare('SELECT * FROM financial_models WHERE founder_id = ? ORDER BY generated_at DESC LIMIT 1').get(req.params.founder_id);
  if (!row) return res.status(404).json({ error: 'No model generated yet' });
  res.json({ model: JSON.parse(row.model_json), generated_at: row.generated_at });
});

// GET /api/report/:email — Public report access
app.get('/api/report/:email', (req, res) => {
  const founder = db.prepare('SELECT * FROM founders WHERE email = ?').get(decodeURIComponent(req.params.email));
  if (!founder) return res.status(404).json({ error: 'No founder found' });

  const model = db.prepare('SELECT * FROM financial_models WHERE founder_id = ? ORDER BY generated_at DESC LIMIT 1').get(founder.id);
  const responses = db.prepare('SELECT module_number, question_number, response_value, response_type FROM intake_responses WHERE founder_id = ?').all(founder.id);

  const answersMap = {};
  responses.forEach(r => { answersMap[`${r.module_number}_${r.question_number}`] = { value: r.response_value, type: r.response_type }; });

  const totalQ = 55;
  const answered = responses.filter(r => r.response_value && r.response_value.trim()).length;

  res.json({
    founder: { name: founder.name, company: founder.company_name, phase: founder.phase, vertical: founder.vertical, customer_type: founder.customer_type },
    intake_progress: { answered, total: totalQ, pct: Math.round(answered / totalQ * 100) },
    responses: answersMap,
    model: model ? JSON.parse(model.model_json) : null,
    generated_at: model?.generated_at
  });
});

// ═══════════════════════════════════════════════════════════
// ADMIN API
// ═══════════════════════════════════════════════════════════

app.post('/api/admin/login', (req, res) => {
  const { email, password } = req.body;
  if (email === ADMIN_EMAIL && password === ADMIN_PASSWORD) {
    const token = Buffer.from(`${email}:${password}`).toString('base64');
    res.json({ success: true, token });
  } else {
    res.status(401).json({ error: 'Invalid credentials' });
  }
});

app.get('/api/admin/founders', authenticateAdmin, (req, res) => {
  const founders = db.prepare(`
    SELECT f.*, 
      (SELECT COUNT(*) FROM intake_responses WHERE founder_id = f.id AND response_value != '') as answers_count,
      (SELECT MAX(finance_score) FROM financial_models WHERE founder_id = f.id) as latest_score,
      (SELECT generated_at FROM financial_models WHERE founder_id = f.id ORDER BY generated_at DESC LIMIT 1) as model_date
    FROM founders f ORDER BY f.updated_at DESC
  `).all();
  res.json({ founders });
});

app.get('/api/admin/founders/:id', authenticateAdmin, (req, res) => {
  const founder = db.prepare('SELECT * FROM founders WHERE id = ?').get(req.params.id);
  if (!founder) return res.status(404).json({ error: 'Not found' });
  const responses = db.prepare('SELECT * FROM intake_responses WHERE founder_id = ? ORDER BY module_number, question_number').all(req.params.id);
  const models = db.prepare('SELECT id, finance_score, generated_at FROM financial_models WHERE founder_id = ? ORDER BY generated_at DESC').all(req.params.id);
  res.json({ founder, responses, models });
});

app.get('/api/admin/analytics', authenticateAdmin, (req, res) => {
  const total = db.prepare('SELECT count(*) as c FROM founders').get().c;
  const byPhase = db.prepare('SELECT phase as label, count(*) as count FROM founders GROUP BY phase ORDER BY count DESC').all();
  const byVertical = db.prepare('SELECT vertical as label, count(*) as count FROM founders WHERE vertical IS NOT NULL GROUP BY vertical ORDER BY count DESC').all();
  const avgScore = db.prepare('SELECT AVG(finance_score) as avg FROM financial_models WHERE finance_score > 0').get()?.avg || 0;
  const modelsGenerated = db.prepare('SELECT count(DISTINCT founder_id) as c FROM financial_models').get().c;
  const avgAnswers = db.prepare('SELECT AVG(cnt) as avg FROM (SELECT founder_id, count(*) as cnt FROM intake_responses WHERE response_value != "" GROUP BY founder_id)').get()?.avg || 0;
  const recent = db.prepare('SELECT id, name, company_name, phase, created_at FROM founders ORDER BY created_at DESC LIMIT 10').all();
  res.json({ total, byPhase, byVertical, avgScore, modelsGenerated, avgAnswers: Math.round(avgAnswers), recent });
});

app.get('/api/admin/export-csv', authenticateAdmin, (req, res) => {
  const rows = db.prepare(`
    SELECT f.id, f.name, f.email, f.company_name, f.phase, f.vertical, f.customer_type, f.created_at,
      (SELECT COUNT(*) FROM intake_responses WHERE founder_id = f.id) as responses,
      (SELECT MAX(finance_score) FROM financial_models WHERE founder_id = f.id) as score
    FROM founders f ORDER BY f.created_at DESC
  `).all();
  if (!rows.length) return res.json({ error: 'No data' });
  const headers = Object.keys(rows[0]);
  const csv = [headers.join(',')];
  rows.forEach(r => {
    csv.push(headers.map(h => {
      const v = r[h]; if (typeof v === 'string' && (v.includes(',') || v.includes('"'))) return `"${v.replace(/"/g, '""')}"`;
      return v ?? '';
    }).join(','));
  });
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename=sbh-founders.csv');
  res.send(csv.join('\n'));
});

// ═══════════════════════════════════════════════════════════
// FINANCIAL MODEL ENGINE
// ═══════════════════════════════════════════════════════════
function generateFinancialModel(founder, answers) {
  const phase = founder.phase || 'idea';
  const bench = BENCHMARKS[phase] || BENCHMARKS.idea;

  // Extract answers with benchmark fallbacks
  const g = (key, fallback) => {
    const v = answers[key];
    return v && v.trim() ? v.trim() : (fallback !== undefined ? String(fallback) : '');
  };
  const gn = (key, fallback) => parseFloat(g(key, fallback)) || fallback || 0;

  const companyName = founder.company_name;
  const currentMRR = gn('2_14', 0);
  const mrrGrowth = gn('2_16', bench.mrr_growth) / 100;
  const grossMargin = gn('2_15', bench.gross_margin) / 100;
  const monthlyChurn = gn('2_17', bench.churn) / 100;
  const cac = gn('3_24', bench.cac);
  const acv = gn('3_25', bench.acv);
  const ltv_cac = gn('3_26', 3);
  const monthlyBurn = gn('4_31', bench.burn);
  const teamSize = gn('1_6', bench.team);
  const hiringPlan = gn('4_33', 3);
  const avgSalary = gn('4_34', 85000);
  const benefitsBurden = gn('4_35', 25) / 100;
  const hostingCost = gn('4_36', 1000);
  const toolsCost = gn('4_37', 300);
  const workspaceCost = gn('4_38', 0);
  const legalCost = gn('4_40', 5000);
  const targetRaise = gn('1_10', bench.raise);
  const valuation = gn('5_42', bench.valuation);
  const timeToRevenue = gn('2_19', phase === 'idea' ? 6 : 0);
  const aiCostPct = gn('2_20', 20) / 100;

  // ─── 5-Year P&L ───
  const pnl = [];
  let mrr = currentMRR;
  let employees = teamSize;
  const annualHireRate = hiringPlan;

  for (let yr = 1; yr <= 5; yr++) {
    // MRR grows monthly, compound for 12 months
    let yearMRR = mrr;
    for (let m = 1; m <= 12; m++) {
      if (yr === 1 && m <= timeToRevenue) continue; // pre-revenue months
      yearMRR *= (1 + mrrGrowth);
      yearMRR *= (1 - monthlyChurn); // net of churn
    }
    const revenue = (mrr + yearMRR) / 2 * 12; // average MRR * 12
    const cogs = revenue * (1 - grossMargin);
    const grossProfit = revenue - cogs;

    employees += annualHireRate * (yr <= 2 ? 1 : yr <= 4 ? 1.5 : 2);
    const totalComp = employees * avgSalary * (1 + benefitsBurden);
    const salesMarketing = revenue * (yr <= 2 ? 0.35 : yr <= 4 ? 0.25 : 0.20);
    const rd = totalComp * 0.55;
    const ga = totalComp * 0.15 + (hostingCost + toolsCost + workspaceCost) * 12 + legalCost;
    const totalOpex = salesMarketing + rd + ga;
    const ebitda = grossProfit - totalOpex;
    const netIncome = ebitda * (ebitda > 0 ? 0.75 : 1); // rough tax

    pnl.push({
      year: yr,
      revenue: Math.round(revenue),
      cogs: Math.round(cogs),
      gross_profit: Math.round(grossProfit),
      gross_margin_pct: revenue > 0 ? +(grossProfit / revenue * 100).toFixed(1) : 0,
      sales_marketing: Math.round(salesMarketing),
      research_development: Math.round(rd),
      general_admin: Math.round(ga),
      total_opex: Math.round(totalOpex),
      ebitda: Math.round(ebitda),
      ebitda_margin_pct: revenue > 0 ? +(ebitda / revenue * 100).toFixed(1) : 0,
      net_income: Math.round(netIncome),
    });

    mrr = yearMRR;
  }

  // ─── ARR Waterfall ───
  const arrWaterfall = [];
  let prevARR = currentMRR * 12;
  for (let yr = 1; yr <= 5; yr++) {
    const endARR = pnl[yr - 1].revenue * 1.1; // approximate
    const newARR = endARR * 0.6;
    const churned = prevARR * monthlyChurn * 12;
    const expansion = endARR * 0.1;
    const yoy = prevARR > 0 ? ((endARR - prevARR) / prevARR * 100) : (endARR > 0 ? 999 : 0);
    const annotations = [];
    if (yr === 1 && prevARR === 0) annotations.push('First Revenue');
    if (endARR >= 1000000 && prevARR < 1000000) annotations.push('$1M ARR');
    if (endARR >= 10000000 && prevARR < 10000000) annotations.push('$10M ARR');

    arrWaterfall.push({
      year: yr,
      start_arr: Math.round(prevARR),
      new_arr: Math.round(newARR),
      churned_arr: Math.round(churned),
      expansion_arr: Math.round(expansion),
      end_arr: Math.round(endARR),
      end_mrr: Math.round(endARR / 12),
      yoy_growth_pct: +Math.min(yoy, 999).toFixed(1),
      annotation: annotations.join(', ') || null,
    });
    prevARR = endARR;
  }

  // ─── Headcount ───
  const headcount = [];
  let hc = teamSize;
  for (let yr = 1; yr <= 5; yr++) {
    hc += annualHireRate * (yr <= 2 ? 1 : yr <= 4 ? 1.5 : 2);
    headcount.push({
      year: yr, total: Math.round(hc),
      engineering: Math.round(hc * 0.50),
      sales_marketing: Math.round(hc * 0.30),
      general_admin: Math.round(hc * 0.20),
    });
  }

  // ─── Cash Position ───
  const cashPosition = [];
  let cash = targetRaise;
  for (let yr = 1; yr <= 5; yr++) {
    const netBurn = pnl[yr - 1].ebitda; // EBITDA proxy for cash flow
    cash += netBurn;
    const runway = netBurn >= 0 ? 60 : Math.max(0, Math.round(cash / Math.abs(netBurn / 12)));
    let milestone = null;
    if (netBurn >= 0 && (yr === 1 || pnl[yr - 2]?.ebitda < 0)) milestone = 'Cash flow positive';
    if (cash < 0) milestone = 'Cash negative — raise needed';
    if (yr === 3 && cash > 0 && netBurn < 0) milestone = 'Bridge round needed';
    cashPosition.push({ year: yr, cash_balance: Math.round(cash), net_burn: Math.round(netBurn), runway_months: runway, milestone });
  }

  // ─── Unit Economics ───
  const ltv = acv / (monthlyChurn > 0 ? monthlyChurn * 12 : 0.5);
  const payback = cac > 0 && acv > 0 ? Math.round(cac / (acv / 12)) : 18;

  const unitEconomics = {
    cac, ltv: Math.round(ltv), ltv_cac_ratio: +(ltv / cac).toFixed(1),
    payback_months: payback,
    acv, monthly_churn: +(monthlyChurn * 100).toFixed(1),
    gross_margin: +(grossMargin * 100).toFixed(1),
    customer_segment: founder.customer_type || 'B2B - SMB',
  };

  // ─── Funding Summary ───
  const breakEvenYear = pnl.findIndex(p => p.ebitda >= 0) + 1 || null;
  const totalFundingNeeded = breakEvenYear ? pnl.slice(0, breakEvenYear - 1).reduce((s, p) => s + Math.abs(Math.min(0, p.ebitda)), 0) + targetRaise : targetRaise * 3;

  const fundingSummary = {
    current_raise: targetRaise,
    total_funding_needed: Math.round(totalFundingNeeded),
    break_even_year: breakEvenYear,
    valuation,
    use_of_proceeds: g('5_47', '50% Product, 30% S&M, 20% Ops'),
  };

  // ─── Finance Score (1-5) ───
  const gates = [];
  const answered = Object.keys(answers).filter(k => answers[k] && answers[k].trim()).length;
  if (answered >= 20) gates.push('Assumption Transparency');
  if (pnl[4]?.revenue > 0 && pnl[0]?.revenue >= 0) gates.push('Revenue Plausibility');
  if (ltv / cac >= 2.0) gates.push('Unit Economics Viability');
  if (cashPosition[0]?.runway_months >= 12 || cashPosition[0]?.net_burn >= 0) gates.push('Runway Integrity');
  if (grossMargin >= 0.50) gates.push('Gross Margin Credibility');
  if (headcount[0]?.total <= 50 && headcount[4]?.total <= 500) gates.push('Headcount Coherence');
  if (answered >= 30) gates.push('Scenario Coverage');

  const score = gates.length <= 1 ? 1 : gates.length <= 2 ? 2 : gates.length <= 4 ? 3 : gates.length <= 5 ? 4 : 5;
  const scoreLabels = { 1: 'Pre-Financial', 2: 'Emerging', 3: 'Developing', 4: 'Investor-Ready', 5: 'Fully Optimized' };

  const financeScore = {
    score, label: scoreLabels[score],
    gates_passed: gates,
    total_gates: 7,
    gap_analysis: gates.length < 7 ?
      `Focus on: ${['Assumption Transparency', 'Revenue Plausibility', 'Unit Economics Viability', 'Runway Integrity', 'Gross Margin Credibility', 'Headcount Coherence', 'Scenario Coverage'].filter(g => !gates.includes(g)).join(', ')}` :
      'All quality gates passed — model is investor-ready.',
  };

  return {
    company_name: companyName,
    phase: founder.phase,
    vertical: founder.vertical,
    customer_type: founder.customer_type,
    five_year_pnl: pnl,
    arr_waterfall: arrWaterfall,
    headcount_summary: headcount,
    cash_position: cashPosition,
    unit_economics: unitEconomics,
    funding_summary: fundingSummary,
    finance_score: financeScore,
    assumptions: {
      mrr_growth: +(mrrGrowth * 100).toFixed(1), gross_margin: +(grossMargin * 100).toFixed(1),
      monthly_churn: +(monthlyChurn * 100).toFixed(1), cac, acv, monthly_burn: monthlyBurn,
      team_size: teamSize, target_raise: targetRaise
    },
  };
}

// ─── Admin Notification ──────────────────────────────────
async function sendAdminNotification(founder, model) {
  if (!transporter) return;
  const score = model.finance_score?.score || 0;
  const scoreEmoji = score >= 4 ? '🟢' : score >= 3 ? '🟡' : '🔴';
  await transporter.sendMail({
    from: process.env.EMAIL_USER,
    to: ADMIN_EMAIL,
    subject: `📊 New Pro Forma Generated — ${founder.company_name} (Score: ${score}/5)`,
    html: `
      <div style="font-family:'Segoe UI',sans-serif;max-width:600px;margin:0 auto;color:#333;">
        <div style="background:#130702;padding:1.5rem;text-align:center;border-radius:8px 8px 0 0;">
          <h2 style="color:#FDF4E2;margin:0;font-weight:300;">New Pro Forma Model</h2>
          <p style="color:#B58A4B;margin-top:0.25rem;font-weight:600;">Silicon Bayou Holdings</p>
        </div>
        <div style="padding:1.5rem;background:#fff;border:1px solid #C9B9A6;">
          <h3 style="color:#130702;margin-top:0;">${founder.company_name}</h3>
          <table style="width:100%;font-size:0.9rem;border-collapse:collapse;">
            <tr><td style="padding:6px 0;color:#888;">Founder</td><td style="font-weight:600;">${founder.name} (${founder.email})</td></tr>
            <tr><td style="padding:6px 0;color:#888;">Phase</td><td style="font-weight:600;">${founder.phase}</td></tr>
            <tr><td style="padding:6px 0;color:#888;">Vertical</td><td>${founder.vertical}</td></tr>
            <tr><td style="padding:6px 0;color:#888;">Finance Score</td><td style="font-weight:700;">${scoreEmoji} ${score}/5 — ${model.finance_score?.label}</td></tr>
            <tr><td style="padding:6px 0;color:#888;">Y1 Revenue</td><td>$${(model.five_year_pnl[0]?.revenue||0).toLocaleString()}</td></tr>
            <tr><td style="padding:6px 0;color:#888;">Y5 Revenue</td><td>$${(model.five_year_pnl[4]?.revenue||0).toLocaleString()}</td></tr>
            <tr><td style="padding:6px 0;color:#888;">Break-Even</td><td>${model.funding_summary?.break_even_year ? 'Year '+model.funding_summary.break_even_year : 'Beyond Y5'}</td></tr>
          </table>
        </div>
      </div>`
  });
  console.log('✓ Admin notification sent');
}

// ─── Founder Confirmation Email ──────────────────────────
async function sendFounderConfirmation(founder, model) {
  if (!transporter) return;
  const score = model.finance_score?.score || 0;
  const scoreLabel = model.finance_score?.label || '';
  const gatesPassed = model.finance_score?.gates_passed?.length || 0;
  const totalGates = model.finance_score?.total_gates || 7;
  const y5Rev = model.five_year_pnl?.[4]?.revenue || 0;
  const breakEven = model.funding_summary?.break_even_year;
  const siteUrl = process.env.SITE_URL || `http://localhost:${PORT}`;

  await transporter.sendMail({
    from: process.env.EMAIL_USER,
    to: founder.email,
    subject: `📊 Your Pro Forma Model is Ready — ${founder.company_name} (Score: ${score}/5)`,
    html: `
      <div style="font-family:'Segoe UI',sans-serif;max-width:600px;margin:0 auto;color:#333;">
        <div style="background:#130702;padding:1.5rem;text-align:center;border-radius:8px 8px 0 0;">
          <h2 style="color:#FDF4E2;margin:0;font-weight:300;">Your Financial Model is Ready</h2>
          <p style="color:#B58A4B;margin-top:0.25rem;font-weight:600;">Silicon Bayou Holdings · AI SaaS Pro Forma</p>
        </div>
        <div style="padding:1.5rem;background:#fff;border:1px solid #C9B9A6;">
          <p>Hi ${founder.name},</p>
          <p>Your 5-year financial model for <strong>${founder.company_name}</strong> has been generated. Here's your snapshot:</p>

          <div style="background:#FDF4E2;border-radius:8px;padding:1rem;margin:1rem 0;text-align:center;">
            <div style="font-size:2rem;font-weight:700;color:${score >= 4 ? '#4F5B45' : score >= 3 ? '#B58A4B' : '#9C4F38'};">${score}/5</div>
            <div style="font-size:0.85rem;color:#676C5C;">Finance Score — ${scoreLabel}</div>
            <div style="font-size:0.75rem;color:#959685;margin-top:0.25rem;">${gatesPassed}/${totalGates} quality gates passed</div>
          </div>

          <table style="width:100%;font-size:0.9rem;border-collapse:collapse;">
            <tr><td style="padding:6px 0;color:#7D8C96;">Phase</td><td style="font-weight:600;">${founder.phase}</td></tr>
            <tr><td style="padding:6px 0;color:#7D8C96;">Vertical</td><td>${founder.vertical}</td></tr>
            <tr><td style="padding:6px 0;color:#7D8C96;">Year 5 Revenue</td><td style="font-weight:600;">$${y5Rev.toLocaleString()}</td></tr>
            <tr><td style="padding:6px 0;color:#7D8C96;">Break-Even</td><td>${breakEven ? 'Year ' + breakEven : 'Beyond Year 5'}</td></tr>
          </table>

          <div style="text-align:center;margin:1.5rem 0;">
            <a href="${siteUrl}/#report/${encodeURIComponent(founder.email)}" style="display:inline-block;background:#130702;color:#FDF4E2;padding:12px 32px;border-radius:6px;text-decoration:none;font-weight:600;">View Your Full Dashboard →</a>
          </div>

          <h3 style="color:#130702;margin-top:1.5rem;">What's Next?</h3>
          <ol style="font-size:0.9rem;line-height:1.8;">
            <li><strong>Review your dashboard</strong> — P&L, unit economics, cash runway, headcount</li>
            <li><strong>Refine your inputs</strong> — update any questions to re-generate</li>
            <li><strong>Share with the SBH team</strong> — we'll help optimize your model</li>
          </ol>

          <div style="background:#FDF4E2;border-left:3px solid #B58A4B;padding:1rem;border-radius:0 6px 6px 0;margin:1.5rem 0;">
            <p style="margin:0;font-weight:600;color:#130702;">💡 Ready to build your fundraise strategy?</p>
            <p style="margin:0.25rem 0 0;font-size:0.85rem;">Connect with Silicon Bayou Holdings for hands-on guidance, pitch prep, and investor introductions.</p>
            <p style="margin:0.5rem 0 0;"><a href="https://siliconbayou.ai" style="color:#B58A4B;font-weight:600;">Schedule a call with SBH →</a></p>
          </div>
        </div>
        <div style="text-align:center;padding:1rem;color:#959685;font-size:0.75rem;">
          Silicon Bayou Holdings · Confidential & Proprietary<br>
          <em>Laissez les bons temps coder!</em>
        </div>
      </div>`
  });
  console.log(`✓ Confirmation email sent to ${founder.email}`);
}

// ─── 7-Day Follow-Up Email ───────────────────────────────
async function sendFollowUp(founder, model) {
  if (!transporter) return;
  const siteUrl = process.env.SITE_URL || `http://localhost:${PORT}`;
  const score = model.finance_score?.score || 0;

  await transporter.sendMail({
    from: process.env.EMAIL_USER,
    to: founder.email,
    subject: `🔄 Week 1 Check-In — ${founder.company_name} Pro Forma`,
    html: `
      <div style="font-family:'Segoe UI',sans-serif;max-width:600px;margin:0 auto;color:#333;">
        <div style="background:#130702;padding:1.5rem;text-align:center;border-radius:8px 8px 0 0;">
          <h2 style="color:#FDF4E2;margin:0;">Week 1 Check-In</h2>
          <p style="color:#B58A4B;margin-top:0.25rem;">Silicon Bayou Holdings</p>
        </div>
        <div style="padding:1.5rem;background:#fff;border:1px solid #C9B9A6;">
          <p>Hi ${founder.name},</p>
          <p>It's been a week since you generated your pro forma model for <strong>${founder.company_name}</strong>. Your Finance Score was <strong>${score}/5</strong>.</p>

          <h3 style="color:#130702;">Three things to consider this week:</h3>
          <ol style="font-size:0.9rem;line-height:1.8;">
            <li><strong>Revisit your assumptions</strong> — Has anything changed since you submitted? Update your inputs and re-generate for a refined model.</li>
            <li><strong>Validate with your market</strong> — Share your unit economics with potential customers or advisors. Does the pricing hold up?</li>
            <li><strong>Start your pitch deck</strong> — Your pro forma gives you the numbers. Now wrap the narrative around them.</li>
          </ol>

          <div style="text-align:center;margin:1.5rem 0;">
            <a href="${siteUrl}/#report/${encodeURIComponent(founder.email)}" style="display:inline-block;background:#130702;color:#FDF4E2;padding:12px 32px;border-radius:6px;text-decoration:none;font-weight:600;">View Your Dashboard →</a>
          </div>

          <div style="background:#FDF4E2;border-left:3px solid #B58A4B;padding:1rem;border-radius:0 6px 6px 0;margin:1.5rem 0;">
            <p style="margin:0;font-weight:600;color:#130702;">Ready to move faster?</p>
            <p style="margin:0.25rem 0 0;font-size:0.85rem;">SBH offers hands-on support for AI SaaS founders — from financial modeling to investor introductions.</p>
            <p style="margin:0.5rem 0 0;"><a href="https://siliconbayou.ai" style="color:#B58A4B;font-weight:600;">Connect with SBH →</a></p>
          </div>
        </div>
        <div style="text-align:center;padding:1rem;color:#959685;font-size:0.75rem;">
          Silicon Bayou Holdings · <em>Laissez les bons temps coder!</em>
        </div>
      </div>`
  });
  console.log(`✓ Follow-up email sent to ${founder.email}`);
}

// ─── Follow-Up Scheduler (hourly check) ──────────────────
setInterval(async () => {
  try {
    // Add column if missing (migration)
    try { db.exec("ALTER TABLE financial_models ADD COLUMN follow_up_sent INTEGER DEFAULT 0"); } catch(e) {}
    try { db.exec("ALTER TABLE financial_models ADD COLUMN confirmation_sent INTEGER DEFAULT 0"); } catch(e) {}

    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const pending = db.prepare(`
      SELECT fm.id as model_id, fm.model_json, f.email, f.name, f.company_name, f.phase, f.vertical
      FROM financial_models fm
      JOIN founders f ON fm.founder_id = f.id
      WHERE fm.follow_up_sent = 0 AND fm.generated_at <= ?
      ORDER BY fm.generated_at ASC LIMIT 5
    `).all(sevenDaysAgo);

    for (const row of pending) {
      try {
        const model = JSON.parse(row.model_json);
        await sendFollowUp({ email: row.email, name: row.name, company_name: row.company_name }, model);
        db.prepare("UPDATE financial_models SET follow_up_sent = 1 WHERE id = ?").run(row.model_id);
        db.prepare("INSERT INTO audit_log (action, detail) VALUES (?, ?)").run('follow_up_sent', `${row.email} — ${row.company_name}`);
      } catch (e) {
        console.error('Follow-up email error:', row.email, e.message);
      }
    }
    if (pending.length) console.log(`✓ Processed ${pending.length} follow-up emails`);
  } catch (e) {
    console.error('Follow-up scheduler error:', e.message);
  }
}, 60 * 60 * 1000); // Every hour

// ─── SPA Routes ──────────────────────────────────────────
app.get('*', (req, res) => {
  if (req.path.startsWith('/api/')) return res.status(404).json({ error: 'Not found' });
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`
  ═══════════════════════════════════════════════
  SILICON BAYOU HOLDINGS — Pro Forma Portal
  ═══════════════════════════════════════════════
  ✓ Server:    http://localhost:${PORT}
  ✓ Portal:    http://localhost:${PORT}
  ✓ Admin:     http://localhost:${PORT}/#admin
  ✓ Database:  ${dbPath}
  ═══════════════════════════════════════════════
  `);
});
