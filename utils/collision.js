// utils/collision.js — colisão física entidade × ilhas.
// Compartilhado por player-manager (barcos de jogadores) e npc-manager (NPCs),
// para que ambos respeitem EXATAMENTE o mesmo contorno.
'use strict';

/**
 * Empurra a entidade (qualquer objeto com .x/.z) para fora de todas as ilhas
 * do mapa. Ilhas = objetos do MAP_DEF com `center` + `islandRadius`
 * (market, lighthouse, banking...).
 *
 * Se a ilha define um array `colliders` (demarcado no editor in-game, tecla 2),
 * as formas SUBSTITUEM o círculo/quadrado do islandRadius — array vazio
 * significa "sem colisão física". Formatos:
 *   { shape:'circle', x, z, r }
 *   { shape:'box',    x, z, hw, hh, rot }
 * x/z são relativos ao center da ilha; rot usa a convenção Godot Basis_Y —
 * a MESMA do editor de colisão e do desenho no minimapa.
 *
 * @param {Object} ent     entidade com .x/.z (mutada in-place)
 * @param {Object} mapDef  MAP_DEFS[nível]
 * @param {number} margin  folga extra (≈ meia-largura do casco)
 * @returns {boolean} true se a entidade foi empurrada por alguma forma
 */
function pushOutOfIslands(ent, mapDef, margin = 6) {
  if (!mapDef) return false;
  let pushed = false;
  for (const val of Object.values(mapDef)) {
    if (!val || typeof val !== 'object' || !val.islandRadius || !val.center) continue;
    const cx = val.center.x || 0;
    const cz = val.center.z || 0;

    if (Array.isArray(val.colliders)) {
      for (const col of val.colliders) {
        if (_pushOutOfShape(ent, cx + (col.x || 0), cz + (col.z || 0), col, margin)) {
          pushed = true;
        }
      }
      continue; // colliders substituem o fallback circular/quadrado
    }

    const r  = val.islandRadius + margin;
    const dx = ent.x - cx;
    const dz = ent.z - cz;
    if (val.islandShape === 'square') {
      // AABB: empurra pelo eixo de menor penetração
      if (Math.abs(dx) < r && Math.abs(dz) < r) {
        const penX = r - Math.abs(dx);
        const penZ = r - Math.abs(dz);
        if (penX < penZ) ent.x = cx + Math.sign(dx || 1) * r;
        else             ent.z = cz + Math.sign(dz || 1) * r;
        pushed = true;
      }
    } else {
      const d2 = dx * dx + dz * dz;
      if (d2 < r * r && d2 > 0) {
        const d = Math.sqrt(d2);
        ent.x = cx + (dx / d) * r;
        ent.z = cz + (dz / d) * r;
        pushed = true;
      }
    }
  }
  return pushed;
}

/** Empurra a entidade para fora de UMA forma (círculo ou caixa rotacionada). */
function _pushOutOfShape(ent, ccx, ccz, col, margin) {
  if (col.shape === 'box') {
    const c = Math.cos(col.rot || 0), s = Math.sin(col.rot || 0);
    const bdx = ent.x - ccx, bdz = ent.z - ccz;
    // mundo → espaço local da caixa (transposta da Godot Basis_Y no plano XZ)
    const lx = c * bdx - s * bdz;
    const lz = s * bdx + c * bdz;
    const ehw = (col.hw || 50) + margin, ehh = (col.hh || 50) + margin;
    if (Math.abs(lx) < ehw && Math.abs(lz) < ehh) {
      let nlx = lx, nlz = lz;
      // empurra pelo eixo de menor penetração
      if (ehw - Math.abs(lx) < ehh - Math.abs(lz)) nlx = (lx >= 0 ? 1 : -1) * ehw;
      else                                          nlz = (lz >= 0 ? 1 : -1) * ehh;
      ent.x = ccx + (c * nlx + s * nlz);   // local → mundo (Basis_Y)
      ent.z = ccz + (-s * nlx + c * nlz);
      return true;
    }
    return false;
  }
  const rr = (col.r || 50) + margin;
  const bdx = ent.x - ccx, bdz = ent.z - ccz;
  const d2 = bdx * bdx + bdz * bdz;
  if (d2 < rr * rr && d2 > 0.0001) {
    const d = Math.sqrt(d2);
    ent.x = ccx + (bdx / d) * rr;
    ent.z = ccz + (bdz / d) * rr;
    return true;
  }
  return false;
}

module.exports = { pushOutOfIslands };
