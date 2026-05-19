const express = require('express');
const prisma = require('../prisma');
const { authMiddleware } = require('../middleware/auth');
const { audit } = require('../middleware/audit');
const { publicUser } = require('../utils/vehicleAccess');
const { notifyUser } = require('../utils/notify');

const router = express.Router();
router.use(authMiddleware);

function shapeFriendship(f, currentUserId) {
  const otherUser = f.requesterId === currentUserId ? f.addressee : f.requester;
  return {
    id: f.id,
    status: f.status,
    direction: f.requesterId === currentUserId ? 'outgoing' : 'incoming',
    friend: publicUser(otherUser),
    createdAt: f.createdAt,
    updatedAt: f.updatedAt,
  };
}

function notify(userId, title, body, type = 'info', relatedId, relatedType) {
  return notifyUser(userId, { title, body, type, relatedId, relatedType });
}

router.get('/', async (req, res) => {
  try {
    const me = req.user.id;
    const friendships = await prisma.friendship.findMany({
      where: {
        status: 'accepted',
        OR: [{ requesterId: me }, { addresseeId: me }],
      },
      include: { requester: true, addressee: true },
      orderBy: { updatedAt: 'desc' },
    });
    res.json(friendships.map(f => shapeFriendship(f, me)));
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Eroare server' });
  }
});

router.get('/pending', async (req, res) => {
  try {
    const me = req.user.id;
    const requests = await prisma.friendship.findMany({
      where: { status: 'pending', addresseeId: me },
      include: { requester: true, addressee: true },
      orderBy: { createdAt: 'desc' },
    });
    res.json(requests.map(f => shapeFriendship(f, me)));
  } catch (e) {
    res.status(500).json({ error: 'Eroare server' });
  }
});

router.get('/sent', async (req, res) => {
  try {
    const me = req.user.id;
    const requests = await prisma.friendship.findMany({
      where: { status: 'pending', requesterId: me },
      include: { requester: true, addressee: true },
      orderBy: { createdAt: 'desc' },
    });
    res.json(requests.map(f => shapeFriendship(f, me)));
  } catch (e) {
    res.status(500).json({ error: 'Eroare server' });
  }
});

router.post('/request', async (req, res) => {
  try {
    const me = req.user.id;
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: 'Email obligatoriu' });

    const cleaned = String(email).trim().toLowerCase();
    if (cleaned === req.user.email.toLowerCase()) {
      return res.status(400).json({ error: 'Nu te poți adăuga pe tine' });
    }

    const target = await prisma.user.findUnique({ where: { email: cleaned } });
    if (!target) return res.status(404).json({ error: 'Utilizator inexistent cu acest email' });

    const existing = await prisma.friendship.findFirst({
      where: {
        OR: [
          { requesterId: me, addresseeId: target.id },
          { requesterId: target.id, addresseeId: me },
        ],
      },
    });
    if (existing) {
      if (existing.status === 'accepted') {
        return res.status(409).json({ error: 'Sunteți deja prieteni' });
      }
      if (existing.status === 'pending') {
        if (existing.addresseeId === me) {
          const accepted = await prisma.friendship.update({
            where: { id: existing.id },
            data: { status: 'accepted' },
            include: { requester: true, addressee: true },
          });
          await notify(existing.requesterId, 'Cerere acceptată', `${req.user.name} a acceptat cererea ta.`, 'info', accepted.id, 'Friendship');
          await audit(me, 'FRIEND_ACCEPTED', 'Friendship', accepted.id, null, req.ip);
          return res.json(shapeFriendship(accepted, me));
        }
        return res.status(409).json({ error: 'Cerere deja trimisă, în așteptare' });
      }
      if (existing.status === 'declined') {
        const updated = await prisma.friendship.update({
          where: { id: existing.id },
          data: { status: 'pending', requesterId: me, addresseeId: target.id },
          include: { requester: true, addressee: true },
        });
        await notify(target.id, 'Cerere de prietenie', `${req.user.name} ți-a trimis o cerere.`, 'info', updated.id, 'Friendship');
        await audit(me, 'FRIEND_REQUEST', 'Friendship', updated.id, null, req.ip);
        return res.status(201).json(shapeFriendship(updated, me));
      }
    }

    const created = await prisma.friendship.create({
      data: { requesterId: me, addresseeId: target.id, status: 'pending' },
      include: { requester: true, addressee: true },
    });
    await notify(target.id, 'Cerere de prietenie', `${req.user.name} ți-a trimis o cerere.`, 'info', created.id, 'Friendship');
    await audit(me, 'FRIEND_REQUEST', 'Friendship', created.id, null, req.ip);
    res.status(201).json(shapeFriendship(created, me));
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Eroare server' });
  }
});

router.put('/:id/accept', async (req, res) => {
  try {
    const me = req.user.id;
    const f = await prisma.friendship.findUnique({ where: { id: req.params.id } });
    if (!f) return res.status(404).json({ error: 'Cerere inexistentă' });
    if (f.addresseeId !== me) return res.status(403).json({ error: 'Nu poți accepta această cerere' });
    if (f.status !== 'pending') return res.status(409).json({ error: 'Cerere deja procesată' });

    const updated = await prisma.friendship.update({
      where: { id: f.id },
      data: { status: 'accepted' },
      include: { requester: true, addressee: true },
    });
    await notify(f.requesterId, 'Cerere acceptată', `${req.user.name} a acceptat cererea ta.`, 'info', updated.id, 'Friendship');
    await audit(me, 'FRIEND_ACCEPTED', 'Friendship', updated.id, null, req.ip);
    res.json(shapeFriendship(updated, me));
  } catch (e) {
    res.status(500).json({ error: 'Eroare server' });
  }
});

router.put('/:id/decline', async (req, res) => {
  try {
    const me = req.user.id;
    const f = await prisma.friendship.findUnique({ where: { id: req.params.id } });
    if (!f) return res.status(404).json({ error: 'Cerere inexistentă' });
    if (f.addresseeId !== me) return res.status(403).json({ error: 'Nu poți respinge această cerere' });
    if (f.status !== 'pending') return res.status(409).json({ error: 'Cerere deja procesată' });

    const updated = await prisma.friendship.update({
      where: { id: f.id },
      data: { status: 'declined' },
      include: { requester: true, addressee: true },
    });
    await audit(me, 'FRIEND_DECLINED', 'Friendship', updated.id, null, req.ip);
    res.json(shapeFriendship(updated, me));
  } catch (e) {
    res.status(500).json({ error: 'Eroare server' });
  }
});

router.delete('/:id', async (req, res) => {
  try {
    const me = req.user.id;
    const f = await prisma.friendship.findUnique({ where: { id: req.params.id } });
    if (!f) return res.status(404).json({ error: 'Inexistent' });
    if (f.requesterId !== me && f.addresseeId !== me) {
      return res.status(403).json({ error: 'Acces interzis' });
    }
    await prisma.friendship.delete({ where: { id: f.id } });
    await audit(me, 'FRIEND_REMOVED', 'Friendship', f.id, null, req.ip);
    res.json({ message: 'Eliminat' });
  } catch (e) {
    res.status(500).json({ error: 'Eroare server' });
  }
});

module.exports = router;
