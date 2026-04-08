const express = require('express');
const multer = require('multer');
const csv = require('csv-parse/sync');
const cors = require('cors');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;

// ── Middleware ──────────────────────────────────────────────
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── Ensure data directory and files exist on startup ────────
// Railway Volume should be mounted at /app/data
// DATA_DIR can be overridden via env var for flexibility
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const DB_PATH = path.join(DATA_DIR, 'companies.json');
const CONTACTS_PATH = path.join(DATA_DIR, 'contacts.json');
const RESPONSES_PATH = path.join(DATA_DIR, 'responses.json');
const SETTINGS_PATH = path.join(DATA_DIR, 'settings.json');

// Initialize empty files only if they don't exist (preserves existing data)
if (!fs.existsSync(DB_PATH)) fs.writeFileSync(DB_PATH, '[]');
if (!fs.existsSync(CONTACTS_PATH)) fs.writeFileSync(CONTACTS_PATH, '[]');
if (!fs.existsSync(RESPONSES_PATH)) fs.writeFileSync(RESPONSES_PATH, '[]');
if (!fs.existsSync(SETTINGS_PATH)) fs.writeFileSync(SETTINGS_PATH, JSON.stringify({ kommo_auto_push: true }));

// Persistent file tracking which company names were already pushed to Kommo
// This survives deploys as long as Railway Volume is mounted at /app/data
const PUSHED_PATH = path.join(DATA_DIR, 'kommo_pushed.json');
if (!fs.existsSync(PUSHED_PATH)) fs.writeFileSync(PUSHED_PATH, '{}');

function getPushedIds() {
  try { return JSON.parse(fs.readFileSync(PUSHED_PATH, 'utf8')); }
  catch { return {}; }
}
function markPushed(companyName, leadId) {
  const pushed = getPushedIds();
  pushed[companyName.toLowerCase().trim()] = { lead_id: leadId, pushed_at: new Date().toISOString() };
  fs.writeFileSync(PUSHED_PATH, JSON.stringify(pushed, null, 2));
}
function wasAlreadyPushed(companyName) {
  const pushed = getPushedIds();
  return !!pushed[companyName?.toLowerCase().trim()];
}

console.log(`[DB] Data directory: ${DATA_DIR}`);
console.log(`[DB] Companies: ${fs.existsSync(DB_PATH) ? JSON.parse(fs.readFileSync(DB_PATH)).length + ' records' : 'new file'}`);
console.log(`[DB] Settings: ${fs.existsSync(SETTINGS_PATH) ? 'loaded' : 'new file'}`);

function readDB(filePath, fallback = []) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch { return fallback; }
}

function writeDB(filePath, data) {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
}

// ── File upload setup ───────────────────────────────────────
const upload = multer({ storage: multer.memoryStorage() });

// ══════════════════════════════════════════════════════════════
// COMPANIES API
// ══════════════════════════════════════════════════════════════

// GET all companies
app.get('/api/companies', (req, res) => {
  const companies = readDB(DB_PATH);
  const { vertical, search, sort } = req.query;
  let result = [...companies];
  if (vertical) result = result.filter(c => c.vertical === vertical);
  if (search) result = result.filter(c =>
    c.company_name?.toLowerCase().includes(search.toLowerCase()) ||
    c.website?.toLowerCase().includes(search.toLowerCase())
  );
  if (sort === 'newest') result.sort((a, b) => new Date(b.added_at) - new Date(a.added_at));
  if (sort === 'score') result.sort((a, b) => (b.lead_score || 0) - (a.lead_score || 0));
  res.json({ total: result.length, companies: result });
});

// GET stats
app.get('/api/stats', (req, res) => {
  const companies = readDB(DB_PATH);
  const contacts = readDB(CONTACTS_PATH);
  const responses = readDB(RESPONSES_PATH);
  const verticals = [...new Set(companies.map(c => c.vertical).filter(Boolean))];
  const byVertical = {};
  verticals.forEach(v => {
    byVertical[v] = companies.filter(c => c.vertical === v).length;
  });
  res.json({
    total_companies: companies.length,
    total_contacts: contacts.length,
    total_responses: responses.length,
    hot_leads: companies.filter(c => (c.lead_score || 0) >= 12).length,
    by_vertical: byVertical,
    last_updated: companies.length ? companies[companies.length - 1].added_at : null
  });
});

// POST upload CSV from Clay
app.post('/api/companies/upload', upload.single('file'), (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

    const content = req.file.buffer.toString('utf8');
    const records = csv.parse(content, {
      columns: true,
      skip_empty_lines: true,
      trim: true
    });

    const existing = readDB(DB_PATH);
    const existingNames = new Set(existing.map(c => c.company?.toLowerCase()));

    let added = 0;
    let skipped = 0;

    const normalized = records.map(r => ({
      id:          `co_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`,
      company:     r['Name'] || r['Company Name'] || r['company'] || '',
      domain:      r['Domain'] || r['Website'] || r['Company Website'] || r['domain'] || '',
      vertical:    r['Primary Industry'] || r['Vertical'] || r['vertical'] || r['Industry'] || '',
      description: r['Description'] || r['description'] || r['Recent Signal'] || '',
      linkedin:    r['LinkedIn URL'] || r['linkedin'] || r['LinkedIn'] || '',
      employees:   r['Size'] || r['Employees'] || r['employees'] || r['Team Size'] || '',
      contact_name:     '',
      contact_role:     '',
      contact_email:    '',
      contact_linkedin: '',
      message:          '',
      lead_score:  0,
      outreach_status: 'Pending',
      added_at:    new Date().toISOString(),
      source:      'Clay CSV'
    })).filter(c => {
      if (!c.company) return false;
      if (existingNames.has(c.company.toLowerCase())) { skipped++; return false; }
      existingNames.add(c.company.toLowerCase());
      added++;
      return true;
    });

    writeDB(DB_PATH, [...existing, ...normalized]);

    res.json({
      message: `Import complete`,
      added,
      skipped,
      total: existing.length + added
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST webhook from Clay (receives enriched data)
app.post('/api/webhook/inbound', (req, res) => {
  try {
    const data = req.body;
    const companies = readDB(DB_PATH);

    // Try to match existing company by name or domain
    const idx = companies.findIndex(c =>
      (c.company && data.company && c.company.toLowerCase() === data.company.toLowerCase()) ||
      (c.domain && data.domain && c.domain.toLowerCase() === data.domain.toLowerCase())
    );

    if (idx >= 0) {
      // Enrich existing record
      companies[idx] = {
        ...companies[idx],
        domain:       data.domain      || companies[idx].domain,
        vertical:     data.vertical    || companies[idx].vertical,
        description:  data.description || companies[idx].description,
        linkedin:     data.linkedin    || companies[idx].linkedin,
        employees:    data.employees   || companies[idx].employees,
        contact_name:    data.contact_name    || companies[idx].contact_name,
        contact_role:    data.contact_role    || companies[idx].contact_role,
        contact_email:   data.contact_email   || companies[idx].contact_email,
        contact_linkedin:data.contact_linkedin|| companies[idx].contact_linkedin,
        message:      data.message     || companies[idx].message,
        lead_score:   parseInt(data.score) || companies[idx].lead_score || 0,
        enriched_at:  new Date().toISOString()
      };
      writeDB(DB_PATH, companies);
    } else {
      // New company
      const newEntry = {
        id:          `co_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`,
        company:     data.company     || '',
        domain:      data.domain      || '',
        vertical:    data.vertical    || '',
        description: data.description || '',
        linkedin:    data.linkedin     || '',
        employees:   data.employees   || '',
        contact_name:    data.contact_name    || '',
        contact_role:    data.contact_role    || '',
        contact_email:   data.contact_email   || '',
        contact_linkedin:data.contact_linkedin|| '',
        message:     data.message     || '',
        lead_score:  parseInt(data.score) || 0,
        outreach_status: 'Pending',
        added_at:    new Date().toISOString(),
        source:      'Clay Webhook'
      };
      companies.push(newEntry);
      writeDB(DB_PATH, companies);

      // Auto-push to Kommo if enabled
      const settings = getSettings();
      if (settings.kommo_auto_push) {
        pushToKommo(newEntry).then(result => {
          if (result.ok) {
            const all = readDB(DB_PATH);
            const i = all.findIndex(x => x.id === newEntry.id);
            if (i >= 0) {
              all[i].kommo_lead_id = result.lead_id;
              all[i].kommo_pushed_at = new Date().toISOString();
              writeDB(DB_PATH, all);
            }
          }
        });
      }
    }

    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST reply notification
app.post('/api/webhook/reply', (req, res) => {
  try {
    const responses = readDB(RESPONSES_PATH);
    responses.unshift({
      id: `rep_${Date.now()}`,
      ...req.body,
      received_at: new Date().toISOString(),
      read: false
    });
    writeDB(RESPONSES_PATH, responses);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET responses
app.get('/api/responses', (req, res) => {
  res.json(readDB(RESPONSES_PATH));
});

// PATCH mark response read
app.patch('/api/responses/:id/read', (req, res) => {
  const responses = readDB(RESPONSES_PATH);
  const idx = responses.findIndex(r => r.id === req.params.id);
  if (idx >= 0) responses[idx].read = true;
  writeDB(RESPONSES_PATH, responses);
  res.json({ ok: true });
});

// PATCH update company status
app.patch('/api/companies/:id', (req, res) => {
  const companies = readDB(DB_PATH);
  const idx = companies.findIndex(c => c.id === req.params.id);
  if (idx >= 0) {
    companies[idx] = { ...companies[idx], ...req.body };
    writeDB(DB_PATH, companies);
    res.json(companies[idx]);
  } else {
    res.status(404).json({ error: 'Not found' });
  }
});

// DELETE company
app.delete('/api/companies/:id', (req, res) => {
  const companies = readDB(DB_PATH);
  writeDB(DB_PATH, companies.filter(c => c.id !== req.params.id));
  res.json({ ok: true });
});

// ══════════════════════════════════════════════════════════════
// KOMMO CRM INTEGRATION
// ══════════════════════════════════════════════════════════════

function getSettings() {
  try {
    const file = JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf8'));
    const rawSubdomain = process.env.KOMMO_SUBDOMAIN || process.env.Kommo || file.kommo_subdomain || '';
    const subdomain = rawSubdomain.replace(/\.kommo\.com.*$/, '').trim();
    const token     = process.env.KOMMO_TOKEN || process.env['Kommo 2'] || file.kommo_token || '';
    const autoPush  = process.env.KOMMO_AUTO_PUSH === 'true' || file.kommo_auto_push || false;
    return { ...file, kommo_subdomain: subdomain, kommo_token: token, kommo_auto_push: autoPush };
  } catch {
    const rawSubdomain = process.env.KOMMO_SUBDOMAIN || process.env.Kommo || '';
    return {
      kommo_subdomain: rawSubdomain.replace(/\.kommo\.com.*$/, '').trim(),
      kommo_token:     process.env.KOMMO_TOKEN || process.env['Kommo 2'] || '',
      kommo_auto_push: true,
    };
  }
}
function saveSettings(data) {
  fs.writeFileSync(SETTINGS_PATH, JSON.stringify(data, null, 2));
}

// Fetch custom field IDs for companies from Kommo
async function getKommoCompanyFields(subdomain, token) {
  try {
    const res = await fetch(`https://${subdomain}.kommo.com/api/v4/companies/custom_fields`, {
      headers: { 'Authorization': `Bearer ${token}` }
    });
    const data = await res.json();
    return data?._embedded?.custom_fields || [];
  } catch { return []; }
}

// Push a single company to Kommo as a lead + company card
async function pushToKommo(company) {
  const settings = getSettings();
  if (!settings.kommo_subdomain || !settings.kommo_token) {
    console.log('[Kommo] Not configured — subdomain or token missing');
    return { ok: false, error: 'Kommo not configured — add subdomain and token in the Kommo CRM tab' };
  }

  const { kommo_subdomain: subdomain, kommo_token: token } = settings;

  // Fetch company custom fields to find text fields only (skip dropdowns/selects)
  const fields = await getKommoCompanyFields(subdomain, token);
  const textFields = fields.filter(f => ['text', 'textarea', 'url', 'multitext'].includes(f.type));
  const fieldMap = {};
  textFields.forEach(f => { fieldMap[f.name.toLowerCase()] = f.id; });
  console.log('[Kommo] Available text fields:', Object.keys(fieldMap).join(', '));

  // Build full summary for Use case / notes
  const summary = [
    company.domain      ? `Website: ${company.domain}`         : null,
    company.vertical    ? `Vertical: ${company.vertical}`       : null,
    company.employees   ? `Employees: ${company.employees}`     : null,
    company.linkedin    ? `LinkedIn: ${company.linkedin}`       : null,
    company.description ? `About: ${company.description}`       : null,
    company.primary_chain ? `Chain: ${company.primary_chain}`   : null,
    `Source: GetBlock Outbound App`,
  ].filter(Boolean).join('\n');

  // Only fill text/textarea/url fields
  const companyCustomFields = [];
  const tryFill = (names, value) => {
    if (!value) return;
    for (const name of names) {
      const id = fieldMap[name.toLowerCase()];
      if (id) { companyCustomFields.push({ field_id: id, values: [{ value }] }); return; }
    }
  };

  // Web field (url type) for domain
  tryFill(['web', 'website', 'сайт', 'url'], company.domain);

  // Build description in exact order: Domain, Employees, LinkedIn, Description
  // Keep under 256 chars for Kommo field limit
  const descParts = [
    company.domain      ? `Web: ${company.domain}`      : null,
    company.employees   ? `Size: ${company.employees}`  : null,
    company.linkedin    ? `LinkedIn: ${company.linkedin}` : null,
    company.description ? `About: ${company.description}` : null,
  ].filter(Boolean);

  let descValue = descParts.join(' | ');
  if (descValue.length > 255) descValue = descValue.substring(0, 252) + '...';

  // Try Description field, then Use case as fallback
  tryFill(['description', 'описание', 'use case', 'usecase', 'use_case'], descValue);

  const url = `https://${subdomain}.kommo.com/api/v4/leads/complex`;
  const body = [{
    name: `${company.company} — GetBlock Outreach`,
    _embedded: {
      companies: [{
        name: company.company,
        ...(companyCustomFields.length ? { custom_fields_values: companyCustomFields } : {})
      }],
      tags: [
        { name: 'GetBlock Outbound' },
        company.vertical ? { name: company.vertical } : null
      ].filter(Boolean),
      notes: [{
        note_type: 'common',
        params: {
          text: [
            `🏢 ${company.company}`,
            company.domain      ? `🌐 ${company.domain}`        : null,
            company.vertical    ? `📂 ${company.vertical}`      : null,
            company.employees   ? `👥 ${company.employees}`     : null,
            company.linkedin    ? `💼 ${company.linkedin}`      : null,
            company.description ? `📝 ${company.description}`   : null,
            company.primary_chain ? `⛓ ${company.primary_chain}` : null,
            `🤖 GetBlock Outbound App`,
          ].filter(Boolean).join('\n')
        }
      }]
    }
  }];

  try {
    console.log(`[Kommo] Pushing: ${company.company} → ${url}`);
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    const data = await res.json();
    console.log(`[Kommo] Response ${res.status}:`, JSON.stringify(data).substring(0, 300));
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}: ${JSON.stringify(data)}` };
    const leadId = data?._embedded?.leads?.[0]?.id;
    // Persist to kommo_pushed.json so it survives deploys
    if (leadId) markPushed(company.company, leadId);
    return { ok: true, lead_id: leadId };
  } catch (err) {
    console.error('[Kommo] Fetch error:', err.message);
    return { ok: false, error: err.message };
  }
}

// GET Kommo settings
app.get('/api/kommo/settings', (req, res) => {
  const s = getSettings();
  res.json({
    subdomain: s.kommo_subdomain || '',
    configured: !!(s.kommo_subdomain && s.kommo_token),
    auto_push: s.kommo_auto_push || false,
    source: (process.env.KOMMO_SUBDOMAIN && process.env.KOMMO_TOKEN) ? 'env' : 'file'
  });
});

// POST save Kommo settings
app.post('/api/kommo/settings', (req, res) => {
  const { subdomain, token, auto_push } = req.body;
  if (!subdomain || !token) return res.status(400).json({ error: 'subdomain and token required' });
  const settings = getSettings();
  settings.kommo_subdomain = subdomain.replace('.kommo.com', '').trim();
  settings.kommo_token = token.trim();
  settings.kommo_auto_push = !!auto_push;
  saveSettings(settings);
  res.json({ ok: true });
});

// POST test Kommo connection
app.post('/api/kommo/test', async (req, res) => {
  const settings = getSettings();
  if (!settings.kommo_subdomain || !settings.kommo_token)
    return res.status(400).json({ error: 'Not configured' });
  try {
    const r = await fetch(`https://${settings.kommo_subdomain}.kommo.com/api/v4/account`, {
      headers: { 'Authorization': `Bearer ${settings.kommo_token}` }
    });
    const data = await r.json();
    if (!r.ok) return res.status(400).json({ error: data.detail || 'Auth failed' });
    res.json({ ok: true, account: data.name });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST push single company to Kommo
app.post('/api/kommo/push/:id', async (req, res) => {
  const companies = readDB(DB_PATH);
  const company = companies.find(c => c.id === req.params.id);
  if (!company) return res.status(404).json({ error: 'Company not found' });
  // Skip if already pushed (check persistent file)
  if (wasAlreadyPushed(company.company)) {
    return res.json({ ok: true, skipped: true, message: 'Already in Kommo' });
  }
  const result = await pushToKommo(company);
  if (result.ok) {
    const idx = companies.findIndex(c => c.id === req.params.id);
    companies[idx].kommo_lead_id = result.lead_id;
    companies[idx].kommo_pushed_at = new Date().toISOString();
    writeDB(DB_PATH, companies);
  }
  res.json(result);
});

// POST push ALL pending companies to Kommo
app.post('/api/kommo/push-all', async (req, res) => {
  const companies = readDB(DB_PATH);
  // Check BOTH the in-memory flag AND the persistent file
  const unpushed = companies.filter(c => !c.kommo_lead_id && !wasAlreadyPushed(c.company));
  let pushed = 0, failed = 0, skipped = 0, firstError = null;

  console.log(`[Kommo] Push-all: ${unpushed.length} to push, ${companies.length - unpushed.length} already in Kommo`);

  for (const c of unpushed) {
    const result = await pushToKommo(c);
    if (result.ok) {
      const idx = companies.findIndex(x => x.id === c.id);
      companies[idx].kommo_lead_id = result.lead_id;
      companies[idx].kommo_pushed_at = new Date().toISOString();
      pushed++;
    } else {
      failed++;
      if (!firstError) firstError = result.error;
    }
    await new Promise(r => setTimeout(r, 300));
  }
  writeDB(DB_PATH, companies);
  res.json({ ok: true, pushed, failed, skipped: companies.length - unpushed.length, total: companies.length, first_error: firstError });
});

// Fallback: serve frontend for all other routes
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`GetBlock Outbound running on port ${PORT}`);
});
