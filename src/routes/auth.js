const prisma = require('../prisma');
const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

const { authMiddleware } = require('../middleware/auth');
const { audit } = require('../middleware/audit');

const router = express.Router();

const avatarStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = path.join(__dirname, '../../uploads/avatars');
    fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname) || '.jpg';
    cb(null, `avatar-${req.user.id}-${Date.now()}${ext}`);
  },
});
const avatarUpload = multer({
  storage: avatarStorage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (!/^image\//.test(file.mimetype)) return cb(new Error('Doar fișiere imagine'));
    cb(null, true);
  },
}).single('avatar');


// Refresh tokens last a full year. They rotate on every /refresh call, so an
// active user effectively stays logged in forever; a phone left untouched for
// more than a year is the only way to get kicked out.
const REFRESH_TOKEN_TTL_MS = 365 * 24 * 60 * 60 * 1000;

function generateTokens(userId) {
  const accessToken = jwt.sign({ userId }, process.env.JWT_SECRET, { expiresIn: '15m' });
  const refreshToken = jwt.sign({ userId }, process.env.JWT_REFRESH_SECRET, { expiresIn: '365d' });
  return { accessToken, refreshToken };
}

function publicUser(u) {
  return {
    id: u.id,
    email: u.email,
    name: u.name,
    phone: u.phone,
    role: u.role,
    avatar: u.avatar,
    pushToken: u.pushToken,
    createdAt: u.createdAt,
    updatedAt: u.updatedAt,
  };
}

router.post('/register', async (req, res) => {
  try {
    const { email, password, name, phone } = req.body;
    if (!email || !password || !name) {
      return res.status(400).json({ error: 'Email, parolă și nume sunt obligatorii' });
    }
    const normalizedEmail = String(email).trim().toLowerCase();
    const existing = await prisma.user.findUnique({ where: { email: normalizedEmail } });
    if (existing) return res.status(409).json({ error: 'Email-ul există deja' });

    const hash = await bcrypt.hash(password, 12);
    const user = await prisma.user.create({
      data: { email: normalizedEmail, password: hash, name, phone: phone || null },
    });

    const { accessToken, refreshToken } = generateTokens(user.id);
    await prisma.refreshToken.create({
      data: {
        token: refreshToken,
        userId: user.id,
        expiresAt: new Date(Date.now() + REFRESH_TOKEN_TTL_MS),
      },
    });

    await audit(user.id, 'REGISTER', 'User', user.id, null, req.ip);

    res.status(201).json({ accessToken, refreshToken, user: publicUser(user) });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Eroare server' });
  }
});

router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email și parolă obligatorii' });

    const normalizedEmail = String(email).trim().toLowerCase();
    const user = await prisma.user.findUnique({ where: { email: normalizedEmail } });
    if (!user) return res.status(401).json({ error: 'Credențiale invalide' });

    const valid = await bcrypt.compare(password, user.password);
    if (!valid) return res.status(401).json({ error: 'Credențiale invalide' });

    const { accessToken, refreshToken } = generateTokens(user.id);
    await prisma.refreshToken.create({
      data: {
        token: refreshToken,
        userId: user.id,
        expiresAt: new Date(Date.now() + REFRESH_TOKEN_TTL_MS),
      },
    });

    await audit(user.id, 'LOGIN', 'User', user.id, null, req.ip);

    res.json({ accessToken, refreshToken, user: publicUser(user) });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Eroare server' });
  }
});

router.post('/refresh', async (req, res) => {
  try {
    const { refreshToken } = req.body;
    if (!refreshToken) return res.status(400).json({ error: 'Refresh token lipsă' });

    const stored = await prisma.refreshToken.findUnique({ where: { token: refreshToken } });
    if (!stored || stored.expiresAt < new Date()) {
      return res.status(401).json({ error: 'Refresh token invalid sau expirat' });
    }

    const payload = jwt.verify(refreshToken, process.env.JWT_REFRESH_SECRET);
    const { accessToken, refreshToken: newRefresh } = generateTokens(payload.userId);

    await prisma.refreshToken.delete({ where: { token: refreshToken } });
    await prisma.refreshToken.create({
      data: {
        token: newRefresh,
        userId: payload.userId,
        expiresAt: new Date(Date.now() + REFRESH_TOKEN_TTL_MS),
      },
    });

    res.json({ accessToken, refreshToken: newRefresh });
  } catch (e) {
    res.status(401).json({ error: 'Token invalid' });
  }
});

router.post('/logout', authMiddleware, async (req, res) => {
  const { refreshToken } = req.body;
  if (refreshToken) {
    await prisma.refreshToken.deleteMany({ where: { token: refreshToken } });
  }
  await audit(req.user.id, 'LOGOUT', 'User', req.user.id, null, req.ip);
  res.json({ message: 'Deconectat cu succes' });
});

router.get('/me', authMiddleware, async (req, res) => {
  const user = await prisma.user.findUnique({ where: { id: req.user.id } });
  if (!user) return res.status(404).json({ error: 'Utilizator inexistent' });
  res.json({ user: publicUser(user) });
});

router.put('/me', authMiddleware, async (req, res) => {
  try {
    const { name, phone, avatar } = req.body;
    const updated = await prisma.user.update({
      where: { id: req.user.id },
      data: {
        ...(name !== undefined ? { name } : {}),
        ...(phone !== undefined ? { phone: phone || null } : {}),
        ...(avatar !== undefined ? { avatar } : {}),
      },
    });
    await audit(req.user.id, 'UPDATE_PROFILE', 'User', req.user.id, null, req.ip);
    res.json(publicUser(updated));
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Eroare server' });
  }
});

router.put('/change-password', authMiddleware, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;
    if (!currentPassword || !newPassword) {
      return res.status(400).json({ error: 'Parola curentă și cea nouă sunt obligatorii' });
    }
    if (newPassword.length < 6) {
      return res.status(400).json({ error: 'Parola nouă trebuie să aibă minim 6 caractere' });
    }
    const valid = await bcrypt.compare(currentPassword, req.user.password);
    if (!valid) return res.status(400).json({ error: 'Parola curentă incorectă' });
    const hash = await bcrypt.hash(newPassword, 12);
    await prisma.user.update({ where: { id: req.user.id }, data: { password: hash } });
    await prisma.refreshToken.deleteMany({ where: { userId: req.user.id } });
    await audit(req.user.id, 'CHANGE_PASSWORD', 'User', req.user.id, null, req.ip);
    res.json({ message: 'Parolă schimbată cu succes' });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Eroare server' });
  }
});

router.post('/avatar', authMiddleware, (req, res) => {
  avatarUpload(req, res, async (err) => {
    if (err) return res.status(400).json({ error: err.message || 'Eroare upload' });
    if (!req.file) return res.status(400).json({ error: 'Nicio imagine primită' });
    try {
      if (req.user.avatar) {
        const oldPath = path.join(__dirname, '../..', req.user.avatar.replace(/^\//, ''));
        fs.unlink(oldPath, () => {});
      }
      const relativeUrl = `/uploads/avatars/${req.file.filename}`;
      const updated = await prisma.user.update({
        where: { id: req.user.id },
        data: { avatar: relativeUrl },
      });
      await audit(req.user.id, 'UPDATE_AVATAR', 'User', req.user.id, null, req.ip);
      res.json(publicUser(updated));
    } catch (e) {
      console.error(e);
      res.status(500).json({ error: 'Eroare server' });
    }
  });
});

router.delete('/avatar', authMiddleware, async (req, res) => {
  try {
    if (req.user.avatar) {
      const oldPath = path.join(__dirname, '../..', req.user.avatar.replace(/^\//, ''));
      fs.unlink(oldPath, () => {});
    }
    const updated = await prisma.user.update({
      where: { id: req.user.id },
      data: { avatar: null },
    });
    await audit(req.user.id, 'DELETE_AVATAR', 'User', req.user.id, null, req.ip);
    res.json(publicUser(updated));
  } catch (e) {
    res.status(500).json({ error: 'Eroare server' });
  }
});

router.put('/push-token', authMiddleware, async (req, res) => {
  try {
    const { pushToken } = req.body;
    const updated = await prisma.user.update({
      where: { id: req.user.id },
      data: { pushToken: pushToken || null },
    });
    res.json(publicUser(updated));
  } catch (e) {
    res.status(500).json({ error: 'Eroare server' });
  }
});

router.get('/export', authMiddleware, async (req, res) => {
  try {
    const userId = req.user.id;
    const [user, vehicles, documents, invoices, reminders, fuelLogs, notifications] = await Promise.all([
      prisma.user.findUnique({ where: { id: userId } }),
      prisma.vehicle.findMany({ where: { userId } }),
      prisma.document.findMany({ where: { userId } }),
      prisma.invoice.findMany({ where: { userId } }),
      prisma.reminder.findMany({ where: { userId } }),
      prisma.fuelLog.findMany({ where: { userId } }),
      prisma.notification.findMany({ where: { userId } }),
    ]);

    await audit(userId, 'EXPORT_DATA', 'User', userId, null, req.ip);

    res.json({
      exportedAt: new Date().toISOString(),
      user: publicUser(user),
      counts: {
        vehicles: vehicles.length,
        documents: documents.length,
        invoices: invoices.length,
        reminders: reminders.length,
        fuelLogs: fuelLogs.length,
        notifications: notifications.length,
      },
      vehicles,
      documents,
      invoices,
      reminders,
      fuelLogs,
      notifications,
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Eroare la export' });
  }
});

router.delete('/me', authMiddleware, async (req, res) => {
  try {
    const { password } = req.body;
    if (!password) return res.status(400).json({ error: 'Parola este obligatorie' });
    const valid = await bcrypt.compare(password, req.user.password);
    if (!valid) return res.status(400).json({ error: 'Parolă incorectă' });

    if (req.user.avatar) {
      const oldPath = path.join(__dirname, '../..', req.user.avatar.replace(/^\//, ''));
      fs.unlink(oldPath, () => {});
    }

    await audit(req.user.id, 'DELETE_ACCOUNT', 'User', req.user.id, null, req.ip);
    await prisma.user.delete({ where: { id: req.user.id } });
    res.json({ message: 'Cont șters cu succes' });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Eroare la ștergerea contului' });
  }
});

module.exports = router;
