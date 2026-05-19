const express = require('express');
const Groq = require('groq-sdk');
const prisma = require('../prisma');
const { authMiddleware } = require('../middleware/auth');
const { accessibleVehicleIds } = require('../utils/vehicleAccess');
const { accessibleHouseholdIds, getHouseholdAccess } = require('../utils/householdAccess');

const router = express.Router();
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

router.use(authMiddleware);

function daysUntil(dateStr) {
  if (!dateStr) return null;
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return null;
  return Math.ceil((d - new Date()) / (1000 * 60 * 60 * 24));
}

function expiryStatus(dateStr) {
  if (!dateStr) return 'nedefinit';
  const days = daysUntil(dateStr);
  if (days === null) return 'nedefinit';
  if (days < 0) return `EXPIRAT cu ${Math.abs(days)} zile`;
  if (days <= 14) return `urgent (${days} zile)`;
  if (days <= 30) return `apropiat (${days} zile)`;
  return `valid (${days} zile)`;
}

function fmt(n, digits = 2) {
  return Number(n || 0).toLocaleString('ro-RO', { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

async function buildUserContext(userId) {
  // Vehicule (owned + shared)
  const accessibleIds = await accessibleVehicleIds(userId);
  const [vehicles, fuelLogs, invoices, reminders, ownedCount, sharedCount] = await Promise.all([
    prisma.vehicle.findMany({ where: { id: { in: accessibleIds } } }),
    prisma.fuelLog.findMany({ where: { vehicleId: { in: accessibleIds } }, orderBy: { date: 'desc' } }),
    prisma.invoice.findMany({ where: { vehicleId: { in: accessibleIds } }, orderBy: { date: 'desc' } }),
    prisma.reminder.findMany({
      where: {
        OR: [{ userId }, { vehicleId: { in: accessibleIds } }],
        isDone: false,
      },
      orderBy: { dueDate: 'asc' },
    }),
    prisma.vehicle.count({ where: { userId } }),
    prisma.vehicleMember.count({ where: { userId } }),
  ]);

  const today = new Date().toISOString().slice(0, 10);

  // Per-vehicle analytics
  const vehicleDetails = vehicles.map(v => {
    const isMine = v.userId === userId;
    const vFuel = fuelLogs.filter(f => f.vehicleId === v.id);
    const vInvoices = invoices.filter(i => i.vehicleId === v.id);
    const totalLiters = vFuel.reduce((s, f) => s + Number(f.liters || 0), 0);
    const totalFuelCost = vFuel.reduce((s, f) => s + Number(f.total || 0), 0);
    const totalInvoiceCost = vInvoices.reduce((s, i) => s + Number(i.amount || 0), 0);

    // Consum mediu L/100km
    let avgConsumption = null;
    if (vFuel.length >= 2) {
      const sorted = [...vFuel].filter(f => f.km).sort((a, b) => a.km - b.km);
      if (sorted.length >= 2) {
        const distance = sorted[sorted.length - 1].km - sorted[0].km;
        if (distance > 0) avgConsumption = (totalLiters / distance) * 100;
      }
    }

    // Status documente
    const docStatuses = {
      ITP: expiryStatus(v.itpDate),
      RCA: expiryStatus(v.rcaDate),
      CASCO: expiryStatus(v.cascoDate),
      Rovinietă: expiryStatus(v.rovDate),
    };

    const expired = Object.entries(docStatuses)
      .filter(([, s]) => s.startsWith('EXPIRAT'))
      .map(([k, s]) => `${k}: ${s}`);

    const urgent = Object.entries(docStatuses)
      .filter(([, s]) => s.startsWith('urgent') || s.startsWith('apropiat'))
      .map(([k, s]) => `${k}: ${s}`);

    const isFunctional = expired.length === 0;

    return {
      plate: v.plate,
      brand: v.brand,
      model: v.model,
      year: v.year,
      fuel: v.fuel,
      km: v.km,
      vin: v.vin,
      color: v.color,
      category: v.category,
      role: isMine ? 'proprietar' : 'membru',
      itp: v.itpDate || null,
      rca: v.rcaDate || null,
      casco: v.cascoDate || null,
      rovinieta: v.rovDate || null,
      docStatuses,
      expired,
      urgent,
      isFunctional,
      fuelLogsCount: vFuel.length,
      totalLiters,
      totalFuelCost,
      avgConsumption,
      invoicesCount: vInvoices.length,
      totalInvoiceCost,
      lastFuelDate: vFuel[0]?.date || null,
      lastService: vInvoices.find(i => i.category === 'service')?.date || null,
    };
  });

  // Aggregate metrics across all vehicles
  const totalKm = vehicles.reduce((s, v) => s + (Number(v.km) || 0), 0);
  const totalLiters = fuelLogs.reduce((s, f) => s + Number(f.liters || 0), 0);
  const totalFuelCost = fuelLogs.reduce((s, f) => s + Number(f.total || 0), 0);
  const totalSpent = invoices.reduce((s, i) => s + Number(i.amount || 0), 0);
  const grandTotal = totalSpent + totalFuelCost;

  // Reminders active
  const upcomingReminders = reminders.slice(0, 10).map(r => ({
    title: r.title,
    type: r.type,
    dueDate: r.dueDate,
    status: expiryStatus(r.dueDate),
    vehicleId: r.vehicleId,
  }));

  // Spent per category
  const byCategory = {};
  invoices.forEach(i => {
    const c = i.category || 'altele';
    byCategory[c] = (byCategory[c] || 0) + Number(i.amount || 0);
  });

  // Status global
  const allFunctional = vehicleDetails.every(v => v.isFunctional);
  const nonFunctionalCount = vehicleDetails.filter(v => !v.isFunctional).length;

  return {
    today,
    user: { id: userId },
    summary: {
      vehiclesTotal: vehicles.length,
      vehiclesOwned: ownedCount,
      vehiclesShared: sharedCount,
      vehiclesFunctional: vehicleDetails.filter(v => v.isFunctional).length,
      vehiclesNonFunctional: nonFunctionalCount,
      allFunctional,
      totalKm,
      totalLiters,
      totalFuelCost,
      totalInvoiceSpent: totalSpent,
      grandTotal,
      fuelLogsCount: fuelLogs.length,
      invoicesCount: invoices.length,
      pendingRemindersCount: reminders.length,
    },
    byCategory,
    vehicles: vehicleDetails,
    upcomingReminders,
  };
}

function contextToText(ctx) {
  if (!ctx) return '';
  const s = ctx.summary;
  const lines = [];

  lines.push(`### CONTEXT UTILIZATOR (data: ${ctx.today})`);
  lines.push('');

  lines.push(`## SUMAR GLOBAL`);
  lines.push(`- Vehicule accesibile: ${s.vehiclesTotal} (proprii: ${s.vehiclesOwned}, partajate: ${s.vehiclesShared})`);
  lines.push(`- Vehicule funcționale: ${s.vehiclesFunctional}/${s.vehiclesTotal}${s.allFunctional ? ' — TOATE OK' : ` (${s.vehiclesNonFunctional} cu documente expirate)`}`);
  lines.push(`- Kilometraj cumulat: ${s.totalKm.toLocaleString('ro-RO')} km`);
  lines.push(`- Combustibil consumat: ${fmt(s.totalLiters, 1)} L (${fmt(s.totalFuelCost)} RON)`);
  lines.push(`- Facturi: ${s.invoicesCount} înregistrări, ${fmt(s.totalInvoiceSpent)} RON`);
  lines.push(`- TOTAL CHELTUIT (facturi + combustibil): ${fmt(s.grandTotal)} RON`);
  lines.push(`- Remindere active neîncheiate: ${s.pendingRemindersCount}`);
  lines.push('');

  if (Object.keys(ctx.byCategory).length > 0) {
    lines.push(`## CHELTUIELI PE CATEGORII`);
    Object.entries(ctx.byCategory).forEach(([cat, amt]) => {
      lines.push(`- ${cat}: ${fmt(amt)} RON`);
    });
    lines.push('');
  }

  if (ctx.vehicles.length === 0) {
    lines.push(`Utilizatorul nu are niciun vehicul înregistrat.`);
  } else {
    lines.push(`## VEHICULE`);
    ctx.vehicles.forEach((v, i) => {
      lines.push(`### Vehicul ${i + 1}: ${v.brand} ${v.model} (${v.plate})`);
      lines.push(`- An: ${v.year} · Combustibil: ${v.fuel} · Categorie: ${v.category} · Rol: ${v.role}`);
      lines.push(`- Kilometraj actual: ${(v.km || 0).toLocaleString('ro-RO')} km`);
      if (v.vin) lines.push(`- VIN: ${v.vin}`);
      if (v.color) lines.push(`- Culoare: ${v.color}`);
      lines.push(`- Documente:`);
      lines.push(`  • ITP: ${v.itp || 'nedefinit'} (${v.docStatuses.ITP})`);
      lines.push(`  • RCA: ${v.rca || 'nedefinit'} (${v.docStatuses.RCA})`);
      lines.push(`  • CASCO: ${v.casco || 'nedefinit'} (${v.docStatuses.CASCO})`);
      lines.push(`  • Rovinietă: ${v.rovinieta || 'nedefinit'} (${v.docStatuses.Rovinietă})`);
      lines.push(`- Status: ${v.isFunctional ? '✅ FUNCȚIONAL (toate documentele valide sau nedefinite)' : '⚠️ NEFUNCȚIONAL — ' + v.expired.join(', ')}`);
      if (v.urgent.length > 0) lines.push(`- ATENȚIE termene apropiate: ${v.urgent.join(', ')}`);
      lines.push(`- Combustibil: ${v.fuelLogsCount} alimentări, ${fmt(v.totalLiters, 1)} L (${fmt(v.totalFuelCost)} RON)${v.avgConsumption ? `, consum mediu ${fmt(v.avgConsumption, 1)} L/100km` : ''}`);
      lines.push(`- Cheltuieli: ${v.invoicesCount} facturi, ${fmt(v.totalInvoiceCost)} RON`);
      if (v.lastFuelDate) lines.push(`- Ultima alimentare: ${v.lastFuelDate}`);
      if (v.lastService) lines.push(`- Ultimul service înregistrat: ${v.lastService}`);
      lines.push('');
    });
  }

  if (ctx.upcomingReminders.length > 0) {
    lines.push(`## URMĂTOARELE 10 REMINDERE`);
    ctx.upcomingReminders.forEach(r => {
      lines.push(`- "${r.title}" (${r.type}) — scadent ${r.dueDate} — ${r.status}`);
    });
    lines.push('');
  }

  return lines.join('\n');
}

// ───────────────────────────── HOUSEHOLD CONTEXT ─────────────────────────────

function startOfMonth(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`;
}
function startOfPrevMonth(d = new Date()) {
  const pm = new Date(d.getFullYear(), d.getMonth() - 1, 1);
  return `${pm.getFullYear()}-${String(pm.getMonth() + 1).padStart(2, '0')}-01`;
}

async function buildHouseholdContext(userId, requestedHouseholdId) {
  // Resolve which households to load — single one if requested, otherwise all
  // accessible (owned + shared).
  let householdIds;
  if (requestedHouseholdId) {
    const access = await getHouseholdAccess(userId, requestedHouseholdId);
    if (!access.ok) return null;
    householdIds = [requestedHouseholdId];
  } else {
    householdIds = await accessibleHouseholdIds(userId);
  }
  if (!householdIds.length) return { today: new Date().toISOString().slice(0, 10), households: [], summary: null };

  const today = new Date().toISOString().slice(0, 10);
  const monthStart = startOfMonth();
  const prevMonthStart = startOfPrevMonth();

  const [households, expenses, incomes, events, bills, budgetCats, memberCount] = await Promise.all([
    prisma.household.findMany({ where: { id: { in: householdIds } } }),
    prisma.householdExpense.findMany({
      where: { householdId: { in: householdIds }, date: { gte: prevMonthStart } },
      orderBy: { date: 'desc' },
    }),
    prisma.householdIncome.findMany({
      where: { householdId: { in: householdIds }, date: { gte: prevMonthStart } },
      orderBy: { date: 'desc' },
    }),
    prisma.householdEvent.findMany({
      where: { householdId: { in: householdIds }, isDone: false, startDate: { gte: today } },
      orderBy: { startDate: 'asc' },
      take: 15,
    }),
    prisma.householdBill.findMany({ where: { householdId: { in: householdIds } }, orderBy: { dueDate: 'asc' } }),
    prisma.budgetCategory.findMany({ where: { householdId: { in: householdIds } }, orderBy: { sortOrder: 'asc' } }),
    prisma.householdMember.count({ where: { householdId: { in: householdIds } } }),
  ]);

  const householdDetails = households.map(h => {
    const myExp = expenses.filter(e => e.householdId === h.id);
    const myInc = incomes.filter(i => i.householdId === h.id);
    const myBills = bills.filter(b => b.householdId === h.id);
    const myCats = budgetCats.filter(c => c.householdId === h.id);

    const thisMonthExp = myExp.filter(e => (e.date || '') >= monthStart);
    const prevMonthExp = myExp.filter(e => (e.date || '') < monthStart && (e.date || '') >= prevMonthStart);
    const thisMonthInc = myInc.filter(e => (e.date || '') >= monthStart);
    const thisMonthSpent = thisMonthExp.reduce((s, e) => s + Number(e.amount || 0), 0);
    const prevMonthSpent = prevMonthExp.reduce((s, e) => s + Number(e.amount || 0), 0);
    const thisMonthEarned = thisMonthInc.reduce((s, i) => s + Number(i.amount || 0), 0);

    const byCategory = {};
    thisMonthExp.forEach(e => {
      const c = e.category || 'altele';
      byCategory[c] = (byCategory[c] || 0) + Number(e.amount || 0);
    });

    const totalLimit = myCats.reduce((s, c) => s + Number(c.monthlyLimit || 0), 0);
    const budgetWithSpent = myCats.map(c => ({
      key: c.key, label: c.label, icon: c.icon, color: c.color,
      monthlyLimit: Number(c.monthlyLimit || 0),
      spent: Number(byCategory[c.key] || 0),
    }));
    const overBudget = budgetWithSpent.filter(c => c.monthlyLimit > 0 && c.spent > c.monthlyLimit);

    const upcomingBills = myBills
      .filter(b => b.status === 'due' || b.status === 'overdue')
      .map(b => ({
        provider: b.provider,
        name: b.name,
        amount: Number(b.amount || 0),
        dueDate: b.dueDate,
        status: b.status === 'overdue' ? `RESTANT cu ${Math.abs(daysUntil(b.dueDate) || 0)} zile` :
                expiryStatus(b.dueDate),
        recurring: b.recurring,
      }));

    const overdueBillCount = myBills.filter(b => b.status === 'overdue').length;
    const monthlyBillsTotal = myBills
      .filter(b => b.recurring === 'lunar')
      .reduce((s, b) => s + Number(b.amount || 0), 0);

    return {
      id: h.id,
      name: h.name,
      type: h.type,
      address: h.address,
      rooms: h.rooms,
      surface: h.surface,
      monthlyBudget: Number(h.monthlyBudget || 0),
      isMine: h.userId === userId,
      thisMonthSpent,
      prevMonthSpent,
      thisMonthEarned,
      monthDelta: prevMonthSpent > 0 ? ((thisMonthSpent - prevMonthSpent) / prevMonthSpent) * 100 : null,
      monthBalance: thisMonthEarned - thisMonthSpent,
      byCategory,
      categoriesCount: myCats.length,
      budgetTotalLimit: totalLimit,
      budgetWithSpent,
      overBudget,
      billsCount: myBills.length,
      monthlyBillsTotal,
      upcomingBills,
      overdueBillCount,
      events: events.filter(e => e.householdId === h.id),
    };
  });

  const summary = {
    householdsTotal: households.length,
    membersTotal: memberCount + households.filter(h => h.userId === userId).length,
    thisMonthSpentAll: householdDetails.reduce((s, h) => s + h.thisMonthSpent, 0),
    thisMonthEarnedAll: householdDetails.reduce((s, h) => s + h.thisMonthEarned, 0),
    overdueBillsTotal: householdDetails.reduce((s, h) => s + h.overdueBillCount, 0),
    overBudgetCategoriesTotal: householdDetails.reduce((s, h) => s + h.overBudget.length, 0),
    expenseCount: expenses.length,
    incomeCount: incomes.length,
  };

  return { today, households: householdDetails, summary };
}

function householdContextToText(ctx) {
  if (!ctx) return '';
  if (!ctx.households.length) {
    return `### CONTEXT UTILIZATOR (data: ${ctx.today})\n\nUtilizatorul NU are nicio locuință adăugată în aplicație.`;
  }
  const lines = [];
  const s = ctx.summary;

  lines.push(`### CONTEXT UTILIZATOR (data: ${ctx.today})`);
  lines.push('');
  lines.push(`## SUMAR GLOBAL`);
  lines.push(`- Locuințe accesibile: ${s.householdsTotal}`);
  lines.push(`- Cheltuit luna asta (toate locuințele): ${fmt(s.thisMonthSpentAll)} RON`);
  lines.push(`- Câștigat luna asta: ${fmt(s.thisMonthEarnedAll)} RON`);
  lines.push(`- Balanță netă luna asta: ${fmt(s.thisMonthEarnedAll - s.thisMonthSpentAll)} RON`);
  lines.push(`- Facturi restante (total): ${s.overdueBillsTotal}`);
  lines.push(`- Categorii peste buget (total): ${s.overBudgetCategoriesTotal}`);
  lines.push('');

  ctx.households.forEach((h, i) => {
    lines.push(`## LOCUINȚĂ ${i + 1}: ${h.name}${h.address ? ` — ${h.address}` : ''}`);
    lines.push(`- Tip: ${h.type || 'apartament'}${h.rooms ? ` · ${h.rooms} camere` : ''}${h.surface ? ` · ${h.surface} m²` : ''}`);
    lines.push(`- Rol: ${h.isMine ? 'proprietar' : 'membru'}`);
    if (h.monthlyBudget > 0) lines.push(`- Buget lunar declarat: ${fmt(h.monthlyBudget)} RON`);
    lines.push('');

    lines.push(`### LUNA ASTA`);
    lines.push(`- Cheltuit: ${fmt(h.thisMonthSpent)} RON${h.monthDelta != null ? ` (${h.monthDelta >= 0 ? '+' : ''}${h.monthDelta.toFixed(1)}% vs luna trecută)` : ''}`);
    lines.push(`- Câștigat: ${fmt(h.thisMonthEarned)} RON`);
    lines.push(`- Balanță: ${fmt(h.monthBalance)} RON`);
    lines.push('');

    if (Object.keys(h.byCategory).length > 0) {
      lines.push(`### CHELTUIELI PE CATEGORIE (luna asta)`);
      Object.entries(h.byCategory)
        .sort((a, b) => b[1] - a[1])
        .forEach(([cat, amt]) => lines.push(`- ${cat}: ${fmt(amt)} RON`));
      lines.push('');
    }

    if (h.budgetWithSpent.length > 0) {
      lines.push(`### BUGET LUNAR PE CATEGORII`);
      h.budgetWithSpent.forEach(c => {
        const pct = c.monthlyLimit > 0 ? Math.round((c.spent / c.monthlyLimit) * 100) : null;
        const tag = c.monthlyLimit === 0
          ? 'fără limită'
          : c.spent > c.monthlyLimit
            ? `OVER (${pct}%)`
            : pct >= 85
              ? `aproape de limită (${pct}%)`
              : `${pct}%`;
        lines.push(`- ${c.label}: ${fmt(c.spent)} / ${fmt(c.monthlyLimit)} RON — ${tag}`);
      });
      if (h.overBudget.length > 0) {
        lines.push(`- ATENȚIE — categorii peste buget: ${h.overBudget.map(c => c.label).join(', ')}`);
      }
      lines.push('');
    }

    if (h.upcomingBills.length > 0) {
      lines.push(`### FACTURI DE PLĂTIT (next ${Math.min(8, h.upcomingBills.length)})`);
      h.upcomingBills.slice(0, 8).forEach(b => {
        lines.push(`- ${b.name} (${b.provider}): ${fmt(b.amount)} RON — scadent ${b.dueDate} — ${b.status}`);
      });
      lines.push(`- Total facturi recurente lunare: ${fmt(h.monthlyBillsTotal)} RON`);
      if (h.overdueBillCount > 0) lines.push(`- ${h.overdueBillCount} factură/i restante`);
      lines.push('');
    }

    if (h.events.length > 0) {
      lines.push(`### EVENIMENTE PROGRAMATE (next ${Math.min(8, h.events.length)})`);
      h.events.slice(0, 8).forEach(ev => {
        lines.push(`- ${ev.title} (${ev.type}) — ${ev.startDate}${ev.startTime ? ' ' + ev.startTime : ''}${ev.location ? ' @ ' + ev.location : ''}`);
      });
      lines.push('');
    }
  });

  return lines.join('\n');
}

const SYSTEM_HOUSEHOLD = `Ești Urbio AI, un asistent specializat în administrarea locuinței (cheltuieli, venituri, facturi, buget și evenimente) pentru utilizatori din România.

REGULI IMPORTANTE:
1. Răspunzi DOAR în limba română.
2. Pentru orice întrebare despre cheltuielile / facturile / bugetul / veniturile / evenimentele utilizatorului, folosește EXCLUSIV datele din "CONTEXT UTILIZATOR" de mai jos. NU inventa cifre.
3. Dacă utilizatorul nu are date despre ce întreabă, spune-i clar (ex: "Nu ai încă nicio factură de curent înregistrată") și sugerează cum să o adauge.
4. Răspunsuri concise (sub 200 cuvinte de obicei), cu cifre clare în RON și bullet points dacă ajută.
5. Calculează diferențele tu (luna asta vs luna trecută, procente, restante), folosind cifrele din context.
6. Identifică din proprie inițiativă riscuri: categorii peste buget, facturi restante, cheltuieli care cresc lună de lună, lipsă buget pe o categorie cu cheltuieli mari etc.
7. Pentru întrebări generale (sfaturi de economisire, cum funcționează asociația de proprietari, ce poți deduce fiscal), folosește cunoștințele tale generale — dar precizează clar că e info generală.
8. NU oferi sfaturi medicale, juridice sau de investiții personalizate.

DEFINIȚII:
- "Categorie peste buget" = cheltuieli pe acea categorie luna asta > limita lunară definită.
- "Factură restantă" = status overdue (data scadenței a trecut și nu e marcată ca plătită).
- "Balanță netă" = venituri - cheltuieli pe luna în curs.
- Datele acoperă luna curentă + luna trecută pentru cheltuieli/venituri, dar TOATE facturile recurente.`;

const SYSTEM_BASE = `Ești Urbio AI, un asistent specializat în autovehicule din România.

REGULI IMPORTANTE:
1. Răspunzi DOAR în limba română.
2. Atunci când utilizatorul întreabă despre datele lui (mașini, consum, costuri, scadențe), folosește EXCLUSIV informațiile din "CONTEXT UTILIZATOR" de mai jos. NU inventa date.
3. Dacă utilizatorul nu are date despre ce întreabă, spune-i clar (ex: "Nu ai înregistrat încă nicio alimentare pentru BMW-ul tău") și sugerează cum să le adauge.
4. Răspunsuri concise (sub 200 cuvinte de obicei), folosind cifre și bullet points unde ajută.
5. Pentru întrebări generale (legislație, sfaturi service), folosește cunoștințele tale generale — dar precizează clar că e info generală, nu din datele lui.
6. NU oferi sfaturi medicale, juridice sau financiare specifice. Sfaturi auto generale sunt OK.
7. Când spui că un vehicul e "funcțional" sau "nefuncțional", referința este: documente (ITP, RCA, Rovinietă) valide. Adăugarea de defecte mecanice nu este urmărită — menționează asta dacă e cazul.

DEFINIȚII:
- Un vehicul este "funcțional" dacă toate documentele setate sunt valide (neexpirate). Documentele nedefinite (NULL) nu fac vehiculul nefuncțional, dar sugerează utilizatorului să le adauge.
- "Consum mediu" se calculează din kilometrii parcurși între alimentări, nu doar din ultima alimentare.`;

async function buildSystemPrompt(userId, mode, householdId) {
  if (mode === 'household') {
    const ctx = await buildHouseholdContext(userId, householdId);
    return `${SYSTEM_HOUSEHOLD}\n\n${householdContextToText(ctx)}`;
  }
  const ctx = await buildUserContext(userId);
  return `${SYSTEM_BASE}\n\n${contextToText(ctx)}`;
}

router.post('/chat', async (req, res) => {
  try {
    const { messages, mode, householdId } = req.body;
    if (!messages || !Array.isArray(messages)) {
      return res.status(400).json({ error: 'Mesaje invalide' });
    }
    const effectiveMode = mode === 'household' ? 'household' : 'vehicle';

    let systemPrompt;
    try {
      systemPrompt = await buildSystemPrompt(req.user.id, effectiveMode, householdId);
    } catch (ctxErr) {
      console.error('Context build error:', ctxErr.message);
      systemPrompt = effectiveMode === 'household' ? SYSTEM_HOUSEHOLD : SYSTEM_BASE;
    }

    const completion = await groq.chat.completions.create({
      model: 'llama-3.3-70b-versatile',
      messages: [
        { role: 'system', content: systemPrompt },
        ...messages.slice(-10),
      ],
      temperature: 0.4,
      max_tokens: 800,
      stream: false,
    });

    const reply = completion.choices[0]?.message?.content || 'Nu am putut genera un răspuns.';
    res.json({ reply });
  } catch (e) {
    console.error('Groq error:', e.message);

    // Fallback: dacă llama-3.3-70b nu e disponibil (rate limit / model decommissioned), încearcă 8b
    if (e.message?.includes('model') || e.message?.includes('decommissioned')) {
      try {
        const effectiveMode = req.body.mode === 'household' ? 'household' : 'vehicle';
        const systemPrompt = await buildSystemPrompt(req.user.id, effectiveMode, req.body.householdId);
        const fallback = await groq.chat.completions.create({
          model: 'llama-3.1-8b-instant',
          messages: [
            { role: 'system', content: systemPrompt },
            ...(req.body.messages || []).slice(-10),
          ],
          temperature: 0.4,
          max_tokens: 800,
        });
        const reply = fallback.choices[0]?.message?.content || 'Nu am putut genera un răspuns.';
        return res.json({ reply });
      } catch (fallbackErr) {
        console.error('Fallback error:', fallbackErr.message);
      }
    }

    res.status(500).json({ error: 'Eroare AI. Verifică cheia Groq sau încearcă din nou.' });
  }
});

// Endpoint pentru sugestii inteligente bazate pe datele user-ului
router.get('/suggestions', async (req, res) => {
  try {
    const mode = req.query.mode === 'household' ? 'household' : 'vehicle';
    const suggestions = [];

    if (mode === 'household') {
      const ctx = await buildHouseholdContext(req.user.id, req.query.householdId || null);
      if (ctx?.households?.length) {
        if (ctx.summary.overdueBillsTotal > 0) {
          suggestions.push({
            label: '🚨 Ce facturi am restante?',
            value: 'Ce facturi am restante și ce sumă datorez?',
          });
        }
        if (ctx.summary.overBudgetCategoriesTotal > 0) {
          suggestions.push({
            label: '⚠️ Ce categorii sunt peste buget?',
            value: 'Care categorii sunt peste buget luna asta și cu cât?',
          });
        }
        if (ctx.summary.expenseCount > 0) {
          suggestions.push({
            label: '💸 Cât am cheltuit luna asta?',
            value: 'Câți bani am cheltuit luna asta și pe ce categorii principale?',
          });
        }
        if (ctx.summary.thisMonthEarnedAll > 0 || ctx.summary.thisMonthSpentAll > 0) {
          suggestions.push({
            label: '⚖️ Care e balanța mea?',
            value: 'Care e diferența dintre venituri și cheltuieli luna asta?',
          });
        }
        const anyUpcoming = ctx.households.some(h => h.upcomingBills.length > 0);
        if (anyUpcoming) {
          suggestions.push({
            label: '📅 Următoarele scadențe',
            value: 'Care sunt următoarele facturi de plătit, ordonate după scadență?',
          });
        }
      }

      if (suggestions.length < 4) {
        const fallbacks = [
          { label: '💰 Sfaturi de economisire', value: 'Cum pot să economisesc mai bine la facturile casnice?' },
          { label: '🏠 Cum împart costurile', value: 'Cum împart corect cheltuielile între membrii locuinței?' },
          { label: '📊 Buget realist', value: 'Cum stabilesc un buget realist pentru luna viitoare?' },
        ];
        for (const f of fallbacks) {
          if (suggestions.length >= 4) break;
          suggestions.push(f);
        }
      }
      return res.json({ suggestions: suggestions.slice(0, 4) });
    }

    // Vehicle mode (default)
    const ctx = await buildUserContext(req.user.id);

    if (ctx.summary.vehiclesNonFunctional > 0) {
      suggestions.push({
        label: '⚠️ Ce documente expirate am?',
        value: 'Ce documente expirate am și pentru care vehicule?',
      });
    }
    if (ctx.summary.fuelLogsCount > 0) {
      suggestions.push({
        label: '⛽ Cât combustibil am consumat?',
        value: 'Cât combustibil am consumat în total și care e consumul mediu?',
      });
    }
    if (ctx.summary.invoicesCount > 0) {
      suggestions.push({
        label: '💰 Cât am cheltuit luna asta?',
        value: 'Câți bani am cheltuit luna asta cu mașinile și pe ce categorii?',
      });
    }
    if (ctx.summary.vehiclesTotal > 0) {
      suggestions.push({
        label: '🚗 Câte mașini am?',
        value: 'Câte mașini am și care sunt funcționale?',
      });
    }
    if (ctx.upcomingReminders.length > 0) {
      suggestions.push({
        label: '📅 Următoarele scadențe',
        value: 'Care sunt următoarele scadențe pentru mașinile mele?',
      });
    }

    if (suggestions.length < 4) {
      const fallbacks = [
        { label: '🔧 Sfaturi service', value: 'Ce sfaturi ai pentru întreținerea unui motor diesel?' },
        { label: '📋 Documente ITP', value: 'Ce documente sunt necesare pentru ITP în România?' },
        { label: '⛽ Reduc consumul?', value: 'Ce pot face să reduc consumul de combustibil?' },
      ];
      for (const f of fallbacks) {
        if (suggestions.length >= 4) break;
        suggestions.push(f);
      }
    }

    res.json({ suggestions: suggestions.slice(0, 4) });
  } catch (e) {
    console.error('AI suggestions error:', e.message);
    res.json({ suggestions: [] });
  }
});

module.exports = router;
