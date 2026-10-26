import { test } from 'node:test';
import assert from 'node:assert/strict';
import { horarioDaVez, lerHorarios, sortearNicho } from './agenda.js';

const HORARIOS = lerHorarios('12:00, 17:00');
const as = (h: number, m: number) => new Date(2026, 9, 19, h, m);

test('roda dentro da janela de cada horário', () => {
  assert.equal(horarioDaVez(as(12, 0), HORARIOS), '2026-10-19 12:00');
  assert.equal(horarioDaVez(as(12, 9), HORARIOS), '2026-10-19 12:00');
  assert.equal(horarioDaVez(as(17, 3), HORARIOS), '2026-10-19 17:00');
});

test('fora da janela não roda — horário perdido fica perdido', () => {
  assert.equal(horarioDaVez(as(11, 59), HORARIOS), null);
  assert.equal(horarioDaVez(as(12, 10), HORARIOS), null);
  assert.equal(horarioDaVez(as(15, 0), HORARIOS), null);
});

test('horário inválido derruba na leitura', () => {
  assert.throws(() => lerHorarios('25:00'));
  assert.throws(() => lerHorarios('12'));
});

test('sorteia fora dos últimos nichos usados', () => {
  const nichos = ['a', 'b', 'c', 'd'].map((nome) => ({ nome }));
  for (let i = 0; i < 20; i++) {
    const n = sortearNicho(nichos, ['a', 'b', 'c']);
    assert.ok(n && ['c', 'd'].includes(n.nome));
  }
  assert.equal(sortearNicho([], []), null);
  assert.equal(sortearNicho([{ nome: 'x' }], ['x'])?.nome, 'x');
});
