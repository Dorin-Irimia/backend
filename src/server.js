require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');

const authRoutes = require('./routes/auth');
const vehicleRoutes = require('./routes/vehicles');
const documentRoutes = require('./routes/documents');
const invoiceRoutes = require('./routes/invoices');
const reminderRoutes = require('./routes/reminders');
const fuelRoutes = require('./routes/fuel');
const notifRoutes = require('./routes/notifications');
const ocrRoutes = require('./routes/ocr');
const aiRoutes = require('./routes/ai');
const adminRoutes = require('./routes/admin');
const friendsRoutes = require('./routes/friends');
const syncRoutes = require('./routes/sync');
const folderRoutes = require('./routes/folders');
const householdRoutes = require('./routes/households');
const householdExpenseRoutes = require('./routes/householdExpenses');
const householdIncomeRoutes = require('./routes/householdIncomes');
const householdEventRoutes = require('./routes/householdEvents');
const householdBillRoutes = require('./routes/householdBills');
const budgetRoutes = require('./routes/budgets');
const customCategoryRoutes = require('./routes/customCategories');
const dashboardLayoutRoutes = require('./routes/dashboardLayouts');
const filterPresetRoutes = require('./routes/filterPresets');
const serviceRecordRoutes = require('./routes/serviceRecords');
const chatRoutes = require('./routes/chats');

const app = express();

app.use(cors({ origin: '*' }));
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// Request logger – util ca să vezi dacă telefonul ajunge la server
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    const ms = Date.now() - start;
    const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown';
    console.log(`${new Date().toISOString().slice(11, 19)} ${req.method} ${req.originalUrl} → ${res.statusCode} (${ms}ms) [${ip}]`);
  });
  next();
});

app.use('/uploads', express.static(path.join(__dirname, '../uploads')));

app.use('/api/auth', authRoutes);
app.use('/api/vehicles', vehicleRoutes);
app.use('/api/documents', documentRoutes);
app.use('/api/invoices', invoiceRoutes);
app.use('/api/reminders', reminderRoutes);
app.use('/api/fuel', fuelRoutes);
app.use('/api/notifications', notifRoutes);
app.use('/api/ocr', ocrRoutes);
app.use('/api/ai', aiRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/friends', friendsRoutes);
app.use('/api/sync', syncRoutes);
app.use('/api/folders', folderRoutes);
app.use('/api/households', householdRoutes);
app.use('/api/household-expenses', householdExpenseRoutes);
app.use('/api/household-incomes', householdIncomeRoutes);
app.use('/api/household-events', householdEventRoutes);
app.use('/api/household-bills', householdBillRoutes);
app.use('/api/budgets', budgetRoutes);
app.use('/api/custom-categories', customCategoryRoutes);
app.use('/api/dashboard-layouts', dashboardLayoutRoutes);
app.use('/api/filter-presets', filterPresetRoutes);
app.use('/api/service-records', serviceRecordRoutes);
app.use('/api/chats', chatRoutes);

app.get('/api/health', (req, res) => res.json({ status: 'ok', time: new Date().toISOString() }));

// ── Web SPA ───────────────────────────────────────────────────────────────
// Build-ul Vite generează /web/dist/. Îl servim la /app/* iar restul de
// rute care nu sunt /api le redirecționăm tot la index.html, ca să meargă
// react-router fără hash-uri. Dacă build-ul nu există încă, returnăm un
// mesaj prietenos cu instrucțiunile de build — fără să stricăm /api.
const webDist = path.join(__dirname, '../../web/dist');
const fs = require('fs');
if (fs.existsSync(webDist)) {
  app.use('/app', express.static(webDist));
  // SPA fallback — orice cale sub /app (alta decât fișierele statice deja
  // servite) primește index.html. Așa /app/vehicles, /app/expenses etc.
  // încarcă SPA-ul și react-router preia URL-ul de acolo.
  app.get(/^\/app(\/.*)?$/, (req, res) => {
    res.sendFile(path.join(webDist, 'index.html'));
  });
  // Confort: redirecționăm rădăcina spre /app/.
  app.get('/', (req, res) => res.redirect('/app/'));
} else {
  app.get(['/', '/app', '/app/*'], (req, res) => {
    res.status(503).send(
      '<h2>Web build lipsește</h2>' +
      '<p>Rulează <code>cd web && npm install && npm run build</code> apoi repornește serverul.</p>'
    );
  });
}

app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({ error: 'Eroare internă server' });
});

const PORT = process.env.PORT || 3004;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Talon. Backend pornit pe http://0.0.0.0:${PORT}`);
  console.log(`Health check: http://0.0.0.0:${PORT}/api/health`);
});
