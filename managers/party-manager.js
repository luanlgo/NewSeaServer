// managers/party-manager.js
const { uid, sendTo } = require('../utils/helpers');

const PARTY_MAX      = 5;
const INVITE_TIMEOUT = 30_000; // ms — convite expira em 30s

/** uid() retorna inteiro; cliente pode enviar string — normaliza sempre para Number */
function _norm(id) { return Number(id); }

class PartyManager {
  constructor() {
    this.parties       = new Map(); // partyId → { id, members: Set<playerId(Number)>, leaderId }
    this.playerParty   = new Map(); // playerId(Number) → partyId
    this.pendingInvites= new Map(); // inviteeId(Number) → { inviterId(Number), inviterName, timer }
  }

  // ─── Invite ───────────────────────────────────────────────────────────────
  handleInvite(inviter, inviteeId, players) {
    const ieeKey = _norm(inviteeId);
    if (inviter.id === ieeKey) return;

    const invitee = players.get(ieeKey);
    if (!invitee || invitee.dead) {
      sendTo(inviter.ws, { type: 'party_error', reason: 'Jogador não encontrado.' });
      return;
    }

    if (this.playerParty.has(ieeKey)) {
      sendTo(inviter.ws, { type: 'party_error', reason: `${invitee.name} já está em um grupo.` });
      return;
    }

    const partyId = this.playerParty.get(inviter.id);
    if (partyId) {
      const party = this.parties.get(partyId);
      if (party && party.members.size >= PARTY_MAX) {
        sendTo(inviter.ws, { type: 'party_error', reason: `Grupo cheio (máximo ${PARTY_MAX}).` });
        return;
      }
    }

    if (this.pendingInvites.has(ieeKey)) {
      clearTimeout(this.pendingInvites.get(ieeKey).timer);
    }

    const timer = setTimeout(() => {
      this.pendingInvites.delete(ieeKey);
    }, INVITE_TIMEOUT);

    this.pendingInvites.set(ieeKey, { inviterId: inviter.id, inviterName: inviter.name, timer });

    sendTo(invitee.ws, {
      type:        'party_invite_received',
      inviterId:   inviter.id,
      inviterName: inviter.name,
    });

    sendTo(inviter.ws, { type: 'party_invite_sent', inviteeName: invitee.name });
  }

  // ─── Accept ───────────────────────────────────────────────────────────────
  handleAccept(invitee, inviterId, players) {
    const irKey  = _norm(inviterId);
    const ieeKey = _norm(invitee.id);

    const pending = this.pendingInvites.get(ieeKey);
    if (!pending || pending.inviterId !== irKey) {
      sendTo(invitee.ws, { type: 'party_error', reason: 'Convite expirado ou inválido.' });
      return;
    }
    clearTimeout(pending.timer);
    this.pendingInvites.delete(ieeKey);

    if (this.playerParty.has(ieeKey)) {
      sendTo(invitee.ws, { type: 'party_error', reason: 'Você já está em um grupo.' });
      return;
    }

    let partyId = this.playerParty.get(irKey);
    let party;
    if (!partyId) {
      partyId = uid();
      party   = { id: partyId, members: new Set([irKey]), leaderId: irKey };
      this.parties.set(partyId, party);
      this.playerParty.set(irKey, partyId);
    } else {
      party = this.parties.get(partyId);
    }

    if (!party || party.members.size >= PARTY_MAX) {
      sendTo(invitee.ws, { type: 'party_error', reason: 'Grupo cheio.' });
      return;
    }

    party.members.add(ieeKey);
    this.playerParty.set(ieeKey, partyId);
    console.log(`[party] ${invitee.name} joined party ${partyId} (${party.members.size} members)`);

    this._broadcastPartyUpdate(partyId, players);
  }

  // ─── Reject ───────────────────────────────────────────────────────────────
  handleReject(invitee, inviterId, players) {
    const ieeKey = _norm(invitee.id);
    const irKey  = _norm(inviterId);

    const pending = this.pendingInvites.get(ieeKey);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pendingInvites.delete(ieeKey);

    const inviter = players.get(irKey);
    if (inviter) {
      sendTo(inviter.ws, { type: 'party_error', reason: `${invitee.name} recusou o convite.` });
    }
  }

  // ─── Leave ────────────────────────────────────────────────────────────────
  handleLeave(player, players) {
    const pid    = _norm(player.id);
    const partyId = this.playerParty.get(pid);
    if (!partyId) return;

    const party = this.parties.get(partyId);
    if (!party) { this.playerParty.delete(pid); return; }

    party.members.delete(pid);
    this.playerParty.delete(pid);

    if (player.ws?.readyState === 1) sendTo(player.ws, { type: 'party_left' });
    console.log(`[party] ${player.name || pid} left party ${partyId}`);

    if (party.members.size <= 1) {
      for (const memberId of party.members) {
        this.playerParty.delete(memberId);
        const m = players.get(memberId);
        if (m?.ws?.readyState === 1) sendTo(m.ws, { type: 'party_left' });
      }
      this.parties.delete(partyId);
    } else {
      if (party.leaderId === pid) party.leaderId = [...party.members][0];
      this._broadcastPartyUpdate(partyId, players);
    }
  }

  removePlayer(playerId, players) {
    const pid     = _norm(playerId);
    const partyId = this.playerParty.get(pid);
    if (!partyId) return;
    const party = this.parties.get(partyId);
    if (!party) { this.playerParty.delete(pid); return; }

    party.members.delete(pid);
    this.playerParty.delete(pid);

    if (party.members.size <= 1) {
      for (const memberId of party.members) {
        this.playerParty.delete(memberId);
        const m = players.get(memberId);
        if (m?.ws?.readyState === 1) sendTo(m.ws, { type: 'party_left' });
      }
      this.parties.delete(partyId);
    } else {
      if (party.leaderId === pid) party.leaderId = [...party.members][0];
      this._broadcastPartyUpdate(partyId, players);
    }
  }

  clearInvites(playerId) {
    this.pendingInvites.delete(_norm(playerId));
  }

  // ─── Queries ──────────────────────────────────────────────────────────────

  getPartyMembersInZone(playerId, mapLevel, players) {
    const pid     = _norm(playerId);
    const partyId = this.playerParty.get(pid);
    if (!partyId) return [];
    const party = this.parties.get(partyId);
    if (!party) return [];

    const result = [];
    for (const memberId of party.members) {
      if (memberId === pid) continue;
      const m = players.get(memberId);
      if (m && !m.dead && (m.mapLevel || 1) === mapLevel) result.push(m);
    }
    return result;
  }

  areAllies(playerId1, playerId2) {
    const p1 = this.playerParty.get(_norm(playerId1));
    if (!p1) return false;
    return p1 === this.playerParty.get(_norm(playerId2));
  }

  // ─── Internal ─────────────────────────────────────────────────────────────

  _broadcastPartyUpdate(partyId, players) {
    const party = this.parties.get(partyId);
    if (!party) return;

    const members = [];
    for (const memberId of party.members) {
      const m = players.get(memberId);
      if (m) members.push({ id: m.id, name: m.name });
    }

    const msg = JSON.stringify({ type: 'party_update', partyId, members, leaderId: party.leaderId });
    for (const memberId of party.members) {
      const m = players.get(memberId);
      if (m?.ws?.readyState === 1) m.ws.send(msg);
    }
  }
}

module.exports = PartyManager;
