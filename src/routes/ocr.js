const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const Tesseract = require('tesseract.js');
const { authMiddleware } = require('../middleware/auth');

let pdfParse;
try { pdfParse = require('pdf-parse'); } catch {}

const router = express.Router();

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = path.join(__dirname, '../../uploads/ocr');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => cb(null, `ocr-${Date.now()}-${Math.random().toString(36).slice(2)}${path.extname(file.originalname)}`),
});
const upload = multer({ storage, limits: { fileSize: 15 * 1024 * 1024 } });

router.use(authMiddleware);

// ── Single image scan (camera) ────────────────────────────────────────────────
router.post('/scan-talon', upload.single('image'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Imagine lipsă' });
  try {
    const { data: { text } } = await Tesseract.recognize(req.file.path, 'ron+eng', { logger: () => {} });
    fs.unlink(req.file.path, () => {});
    const result = parseTalonText(text);
    res.json({ raw: text, parsed: result });
  } catch (e) {
    console.error('OCR error:', e);
    res.status(500).json({ error: 'Eroare OCR' });
  }
});

// ── Multi-file scan (images + PDFs) ──────────────────────────────────────────
router.post('/scan-files', upload.array('files', 5), async (req, res) => {
  if (!req.files?.length) return res.status(400).json({ error: 'Niciun fișier' });

  const perFile = [];

  for (const file of req.files) {
    let text = '';
    try {
      const isPdf = file.mimetype === 'application/pdf' || path.extname(file.originalname).toLowerCase() === '.pdf';

      if (isPdf && pdfParse) {
        try {
          const buf = fs.readFileSync(file.path);
          const data = await pdfParse(buf);
          text = data.text || '';
        } catch {
          // PDF parse failed — try Tesseract (image-based PDFs)
          try {
            const r = await Tesseract.recognize(file.path, 'ron+eng', { logger: () => {} });
            text = r.data.text;
          } catch {}
        }
      } else {
        const { data: { text: t } } = await Tesseract.recognize(file.path, 'ron+eng', { logger: () => {} });
        text = t;
      }
    } catch {}

    fs.unlink(file.path, () => {});
    perFile.push({ file: file.originalname, parsed: parseTalonText(text) });
  }

  // Merge: first non-empty value wins for each field
  const merged = {};
  for (const { parsed } of perFile) {
    for (const [k, v] of Object.entries(parsed)) {
      if (v && !merged[k]) merged[k] = v;
    }
  }

  res.json({ parsed: merged, files: perFile });
});

// ── Parser ────────────────────────────────────────────────────────────────────
function parseTalonText(text) {
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
  const fullText = lines.join(' ');
  const result = {};

  // Număr înmatriculare
  const plateMatch = fullText.match(/\b([A-Z]{1,2}[\s\-]?\d{2,3}[\s\-]?[A-Z]{2,3})\b/);
  if (plateMatch) result.plate = plateMatch[1].replace(/\s+/g, ' ').trim();

  // VIN
  const vinMatch = fullText.match(/\b([A-HJ-NPR-Z0-9]{17})\b/);
  if (vinMatch) result.vin = vinMatch[1];

  // Marcă — câmpul D.1
  const brandMatch = fullText.match(/D[\.\s]1[:\s]+([A-Za-z\-]+)|[Mm]arc[aă][:\s]+([A-Za-z\-]+)/);
  if (brandMatch) result.brand = (brandMatch[1] || brandMatch[2])?.trim();

  // Model — câmpul D.2/D.3
  const modelMatch = fullText.match(/D[\.\s]2[:\s]+([A-Za-z0-9\s\-]+?)(?=\s+D[\.\s]|\s{2,}|$)|D[\.\s]3[:\s]+([A-Za-z0-9\s\-]+?)(?=\s+[A-Z][\.\s]|\s{2,}|$)|[Tt]ip[:\s]+([A-Za-z0-9\s\-]+?)(?=\s+[A-Z]\.|\s{2,}|$)/);
  if (modelMatch) result.model = (modelMatch[1] || modelMatch[2] || modelMatch[3])?.trim();

  // An fabricație
  const yearMatch = fullText.match(/\b((?:19|20)\d{2})\b/);
  if (yearMatch) result.year = yearMatch[1];

  // Combustibil — câmpul P.3
  const fuelPatterns = [
    { rx: /BENZIN[AĂ]|GASOLINE|PETROL\b/i, val: 'Benzină' },
    { rx: /MOTORIN[AĂ]|DIESEL|GAZOLE/i,    val: 'Motorină' },
    { rx: /HIBRID|HYBRID|HEV|PHEV/i,       val: 'Hibrid' },
    { rx: /ELECTRIC\b|BEV\b/i,             val: 'Electric' },
    { rx: /\bGPL\b|\bLPG\b|AUTOGAS/i,      val: 'GPL' },
    { rx: /\bGNC\b|\bCNG\b|GAZ\s+NATUR/i,  val: 'GNC' },
  ];
  const p3Match = fullText.match(/P[\.\s]3[:\s]+([A-Za-zăîâșț\/\s]+?)(?=\s+[A-Z][\.\s]|\s{2,}|$)/i);
  if (p3Match) {
    for (const { rx, val } of fuelPatterns) {
      if (rx.test(p3Match[1])) { result.fuel = val; break; }
    }
  }
  if (!result.fuel) {
    for (const { rx, val } of fuelPatterns) {
      if (rx.test(fullText)) { result.fuel = val; break; }
    }
  }

  // Putere — câmpul P.2 (kW → CP)
  const p2Match = fullText.match(/P[\.\s]2[:\s]+(\d+)/i);
  const kwMatch  = fullText.match(/(\d+)\s*kW\b/i);
  const cpMatch  = fullText.match(/(\d+)\s*(?:CP|CV|PS|HP)\b/i);
  if (p2Match)      result.power = String(Math.round(parseInt(p2Match[1]) * 1.36));
  else if (kwMatch) result.power = String(Math.round(parseInt(kwMatch[1]) * 1.36));
  else if (cpMatch) result.power = cpMatch[1];

  // Culoare — câmpul H
  const colorMap = {
    'ALB': 'Alb', 'WHITE': 'Alb', 'BLANC': 'Alb',
    'NEGRU': 'Negru', 'BLACK': 'Negru', 'NOIR': 'Negru',
    'GRI': 'Gri', 'GREY': 'Gri', 'GRAY': 'Gri', 'GRIS': 'Gri',
    'ARGINTIU': 'Argintiu', 'SILVER': 'Argintiu', 'ARGENT': 'Argintiu',
    'ALBASTRU': 'Albastru', 'BLUE': 'Albastru', 'BLEU': 'Albastru',
    'ROSU': 'Roșu', 'ROSIU': 'Roșu', 'RED': 'Roșu', 'ROUGE': 'Roșu',
    'VERDE': 'Verde', 'GREEN': 'Verde', 'VERT': 'Verde',
    'GALBEN': 'Galben', 'YELLOW': 'Galben', 'JAUNE': 'Galben',
    'PORTOCALIU': 'Portocaliu', 'ORANGE': 'Portocaliu',
    'MARO': 'Maro', 'BROWN': 'Maro', 'MARRON': 'Maro',
    'BEJ': 'Bej', 'BEIGE': 'Bej',
    'VIOLET': 'Violet', 'PURPLE': 'Violet',
    'BORDO': 'Bordo', 'BORDEAUX': 'Bordo',
  };
  const hMatch     = fullText.match(/\bH[:\s]+([A-ZĂÎÂȘȚ][A-ZĂÎÂȘȚa-zăîâșț\s]+?)(?=\s+[A-Z][\.\s]|\s{2,}|$)/);
  const colorLabel = fullText.match(/[Cc]uloare[:\s]+([A-ZĂÎÂȘȚ][A-ZĂÎÂȘȚa-zăîâșț\s]+?)(?=\s{2,}|$)/);
  const rawColor   = (hMatch?.[1] || colorLabel?.[1] || '').trim().toUpperCase().replace(/[^A-ZĂÎÂȘȚ\s]/g, '').trim();
  if (rawColor) {
    result.color = colorMap[rawColor] || (rawColor.charAt(0) + rawColor.slice(1).toLowerCase());
  } else {
    for (const [key, val] of Object.entries(colorMap)) {
      if (fullText.toUpperCase().includes(key)) { result.color = val; break; }
    }
  }

  // Kilometraj
  const kmMatch = fullText.match(/\b(\d{4,7})\s*(?:km|KM)\b/);
  if (kmMatch) result.km = kmMatch[1];

  return result;
}

module.exports = router;
