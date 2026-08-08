// utils/aoi.js — Grade espacial para interest management (AOI).
//
// O broadcast antigo mandava TODAS as entidades do mapa para TODOS os jogadores
// do mapa: custo O(P²) por mapa. Com 200 jogadores num mapa só isso dava 69 KB
// por mensagem e ~136 MB/s de JSON a 10 Hz.
//
// A grade resolve isso: cada jogador só recebe o que está dentro do raio de AOI.
// O raio é folgado de propósito — o cliente já esconde tudo além de
// `vision_range = cannonRange + 100` (máx. 220u) dentro da névoa volumétrica
// (ver fog_range.gd no cliente), então com 450u nada aparece/some na tela do
// jogador: a entidade entra na lista bem antes de sair da névoa.
'use strict';

// Célula da grade. Precisa ser <= raio de AOI para a busca varrer poucas células
// (com 256 e raio 450 são 5x5 = 25 células no pior caso).
const DEFAULT_CELL = 256;

// Offset para a chave numérica aceitar coordenada negativa sem virar string.
// Com célula 256 isso cobre ±1.048.576 unidades — o maior mapa tem 7.200.
const KEY_OFFSET = 4096;
const KEY_STRIDE = 8192;

class SpatialGrid {
  constructor(cellSize = DEFAULT_CELL) {
    this.cell    = cellSize;
    this.buckets = new Map();
  }

  clear() {
    this.buckets.clear();
  }

  _key(cx, cz) {
    return (cx + KEY_OFFSET) * KEY_STRIDE + (cz + KEY_OFFSET);
  }

  insert(x, z, item) {
    const k = this._key(Math.floor(x / this.cell), Math.floor(z / this.cell));
    let bucket = this.buckets.get(k);
    if (!bucket) { bucket = []; this.buckets.set(k, bucket); }
    bucket.push(item);
  }

  /**
   * Entidades dentro de `radius` de (x, z). Varre só as células da bounding box
   * e faz o teste exato por distância ao quadrado (sem sqrt) — a sobra de
   * células custaria payload à toa.
   */
  query(x, z, radius, out = []) {
    const c    = this.cell;
    const minX = Math.floor((x - radius) / c);
    const maxX = Math.floor((x + radius) / c);
    const minZ = Math.floor((z - radius) / c);
    const maxZ = Math.floor((z + radius) / c);
    const r2   = radius * radius;

    for (let cx = minX; cx <= maxX; cx++) {
      for (let cz = minZ; cz <= maxZ; cz++) {
        const bucket = this.buckets.get(this._key(cx, cz));
        if (!bucket) continue;
        for (let i = 0; i < bucket.length; i++) {
          const e  = bucket[i];
          const dx = e.x - x;
          const dz = e.z - z;
          if (dx * dx + dz * dz <= r2) out.push(e);
        }
      }
    }
    return out;
  }
}

module.exports = { SpatialGrid, DEFAULT_CELL };
