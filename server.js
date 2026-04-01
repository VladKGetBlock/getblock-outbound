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
const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const DB_PATH = path.join(DATA_DIR, 'companies.json');
const CONTACTS_PATH = path.join(DATA_DIR, 'contacts.json');
const RESPONSES_PATH = path.join(DATA_DIR, 'responses.json');

[DB_PATH, CONTACTS_PATH, RESPONSES_PATH].forEach(f => {
  if (!fs.existsSync(f)) fs.writeFileSync(f, '[]');
});

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

// Fallback: serve frontend for all other routes
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`GetBlock Outbound running on port ${PORT}`);
});
