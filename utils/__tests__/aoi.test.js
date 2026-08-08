import { describe, it, expect } from 'vitest';
import { SpatialGrid } from '../aoi.js';

const at = (id, x, z) => ({ id, x, z });
const ids = arr => arr.map(e => e.id).sort((a, b) => a - b);

describe('SpatialGrid — consulta por raio', () => {
  it('retorna só o que está dentro do raio', () => {
    const g = new SpatialGrid(256);
    g.insert(0, 0, at(1, 0, 0));
    g.insert(100, 0, at(2, 100, 0));
    g.insert(500, 0, at(3, 500, 0));

    expect(ids(g.query(0, 0, 200))).toEqual([1, 2]);
  });

  it('a fronteira do raio é inclusiva', () => {
    const g = new SpatialGrid(256);
    g.insert(300, 0, at(1, 300, 0));
    expect(ids(g.query(0, 0, 300))).toEqual([1]);
    expect(ids(g.query(0, 0, 299))).toEqual([]);
  });

  it('funciona com coordenada negativa (a chave da célula não pode colidir)', () => {
    const g = new SpatialGrid(256);
    g.insert(-500, -500, at(1, -500, -500));
    g.insert(500, 500, at(2, 500, 500));
    // Sem o offset na chave, (-2,-2) e (2,2) cairiam no mesmo balde.
    expect(ids(g.query(-500, -500, 50))).toEqual([1]);
    expect(ids(g.query(500, 500, 50))).toEqual([2]);
  });

  it('acha entidades em células vizinhas, não só na própria', () => {
    const g = new SpatialGrid(100); // célula menor que o raio
    // Espalha em volta da origem, todas a 90u — cada uma numa célula diferente.
    g.insert(90, 0, at(1, 90, 0));
    g.insert(-90, 0, at(2, -90, 0));
    g.insert(0, 90, at(3, 0, 90));
    g.insert(0, -90, at(4, 0, -90));

    expect(ids(g.query(0, 0, 100))).toEqual([1, 2, 3, 4]);
  });

  it('usa distância euclidiana, não a caixa da célula', () => {
    const g = new SpatialGrid(256);
    // (200, 200) está a ~283u — fora de um raio de 250, mas dentro da bounding box.
    g.insert(200, 200, at(1, 200, 200));
    expect(ids(g.query(0, 0, 250))).toEqual([]);
    expect(ids(g.query(0, 0, 290))).toEqual([1]);
  });

  it('mapa grande: consulta não devolve o mundo inteiro', () => {
    const g = new SpatialGrid(256);
    // 400 entidades espalhadas num mapa 7200x7200 (o maior do jogo).
    for (let i = 0; i < 400; i++) {
      const x = (i % 20) * 360 - 3600;
      const z = Math.floor(i / 20) * 360 - 3600;
      g.insert(x, z, at(i, x, z));
    }
    const near = g.query(0, 0, 450);
    expect(near.length).toBeGreaterThan(0);
    expect(near.length).toBeLessThan(10); // e não as 400
  });
});
