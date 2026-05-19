const prisma = require('../prisma');

function daysUntil(dateStr) {
  if (!dateStr) return null;
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return null;
  return Math.ceil((d - new Date()) / (1000 * 60 * 60 * 24));
}

function isExpired(dateStr) {
  const d = daysUntil(dateStr);
  return d !== null && d < 0;
}

function isWithinUnavailablePeriod(vehicle, today = new Date()) {
  if (vehicle.isAvailable !== false) {
    // Switch-ul manual e PE "disponibil"
    if (!vehicle.unavailableFrom && !vehicle.unavailableUntil) return false;
  }

  const todayStr = today.toISOString().slice(0, 10);
  if (vehicle.unavailableFrom && todayStr < vehicle.unavailableFrom) return false;
  if (vehicle.unavailableUntil && todayStr > vehicle.unavailableUntil) return false;
  if (vehicle.isAvailable === false) return true;
  return !!(vehicle.unavailableFrom || vehicle.unavailableUntil);
}

/**
 * Returnează starea efectivă a unui vehicul:
 *  - available: poate fi folosit
 *  - unavailable: nu poate fi folosit
 *  - reasons: lista motivelor (manual + documente expirate)
 */
function computeAvailability(vehicle) {
  const reasons = [];

  const manualUnavailable = isWithinUnavailablePeriod(vehicle);
  if (manualUnavailable) {
    reasons.push({
      type: 'manual',
      label: vehicle.unavailableReason || 'Marcat manual ca indisponibil',
      until: vehicle.unavailableUntil || null,
    });
  }

  if (isExpired(vehicle.itpDate)) {
    reasons.push({ type: 'itp_expired', label: `ITP expirat (${vehicle.itpDate})`, until: null });
  }
  if (isExpired(vehicle.rcaDate)) {
    reasons.push({ type: 'rca_expired', label: `RCA expirat (${vehicle.rcaDate})`, until: null });
  }
  if (isExpired(vehicle.rovDate)) {
    reasons.push({ type: 'rov_expired', label: `Rovinietă expirată (${vehicle.rovDate})`, until: null });
  }

  const state = reasons.length > 0 ? 'unavailable' : 'available';
  return { state, reasons, isAvailable: state === 'available' };
}

async function notifyVehicleMembers(vehicleId, title, body, type = 'info') {
  // Delegăm către helper-ul unificat care trimite și push
  const { notifyVehicleMembers: notify } = require('./notify');
  return notify(vehicleId, null /* exclude none for status changes */, { title, body, type });
}

/**
 * Verifică dacă starea efectivă s-a schimbat față de cea salvată,
 * și dacă da, trimite notificări către toți membrii și actualizează lastEffectiveState.
 * Returnează computed availability.
 */
async function checkAndNotifyAvailabilityChange(vehicle) {
  const availability = computeAvailability(vehicle);
  const newState = availability.state;
  const previous = vehicle.lastEffectiveState;

  if (previous && previous !== newState) {
    if (newState === 'unavailable') {
      const reasonsList = availability.reasons.map(r => r.label).join(', ') || 'motiv necunoscut';
      await notifyVehicleMembers(
        vehicle.id,
        `🚫 ${vehicle.brand} ${vehicle.model} indisponibil`,
        `Vehiculul ${vehicle.plate} nu mai este disponibil: ${reasonsList}`,
        'warning',
      );
    } else {
      await notifyVehicleMembers(
        vehicle.id,
        `✅ ${vehicle.brand} ${vehicle.model} disponibil`,
        `Vehiculul ${vehicle.plate} este din nou disponibil pentru utilizare.`,
        'info',
      );
    }
  }

  if (previous !== newState) {
    await prisma.vehicle.update({
      where: { id: vehicle.id },
      data: { lastEffectiveState: newState },
    });
  }

  return availability;
}

/**
 * Update vehicle.km only if newKm is provided AND larger than current.
 */
async function maybeUpdateVehicleKm(vehicleId, newKm) {
  if (!newKm) return;
  const km = parseInt(newKm, 10);
  if (!Number.isFinite(km) || km <= 0) return;
  const vehicle = await prisma.vehicle.findUnique({ where: { id: vehicleId }, select: { km: true } });
  if (!vehicle) return;
  if (km > (vehicle.km || 0)) {
    await prisma.vehicle.update({ where: { id: vehicleId }, data: { km } });
  }
}

module.exports = {
  computeAvailability,
  checkAndNotifyAvailabilityChange,
  notifyVehicleMembers,
  maybeUpdateVehicleKm,
  daysUntil,
  isExpired,
};
