import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MosaicTileGroup, MosaicTileGroupStore, splitAlongAxis } from '../extension/mosaicTileGroup.js';

const WA = { x: 0, y: 32, width: 1920, height: 1048 };

test('member guarda a regiao', () => {
    const group = new MosaicTileGroup(0, 0, WA);
    group.setMember(7, { window: { id: 7 }, region: { x: 0, y: 32, width: 960, height: 1048 } });

    assert.deepEqual(group.regionOf(7), { x: 0, y: 32, width: 960, height: 1048 });
    assert.equal(group.size, 1);
});

test('setMember no mesmo id substitui em vez de duplicar', () => {
    const group = new MosaicTileGroup(0, 0, WA);
    group.setMember(7, { window: { id: 7 }, region: { x: 0, y: 32, width: 960, height: 1048 } });
    group.setMember(7, { window: { id: 7 }, region: { x: 960, y: 32, width: 960, height: 1048 } });

    assert.equal(group.size, 1);
    assert.equal(group.regionOf(7).x, 960);
});

test('a regiao e copiada, nao referenciada', () => {
    const group = new MosaicTileGroup(0, 0, WA);
    const region = { x: 0, y: 32, width: 960, height: 1048 };
    group.setMember(7, { window: { id: 7 }, region });
    region.x = 500;

    assert.equal(group.regionOf(7).x, 0);
});

test('regionOf devolve null para quem nao e membro', () => {
    const group = new MosaicTileGroup(0, 0, WA);
    assert.equal(group.regionOf(404), null);
});

test('partitionViolations aceita membro totalmente dentro da work area', () => {
    const group = new MosaicTileGroup(0, 0, WA);
    group.setMember(7, { window: { id: 7 }, region: { x: 0, y: 32, width: 960, height: 1048 } });

    assert.deepEqual(group.partitionViolations(), []);
});

test('partitionViolations acusa regiao que passa da borda direita', () => {
    const group = new MosaicTileGroup(0, 0, WA);
    group.setMember(8, { window: { id: 8 }, region: { x: 1800, y: 32, width: 400, height: 1048 } });

    assert.deepEqual(group.partitionViolations().map(v => v.windowId), [8]);
});

test('partitionViolations acusa regiao que passa da borda esquerda', () => {
    const group = new MosaicTileGroup(0, 0, WA);
    group.setMember(8, { window: { id: 8 }, region: { x: -10, y: 32, width: 960, height: 1048 } });

    assert.deepEqual(group.partitionViolations().map(v => v.windowId), [8]);
});

test('partitionViolations acusa regiao que passa da borda superior', () => {
    const group = new MosaicTileGroup(0, 0, WA);
    group.setMember(8, { window: { id: 8 }, region: { x: 0, y: 0, width: 960, height: 1048 } });

    assert.deepEqual(group.partitionViolations().map(v => v.windowId), [8]);
});

test('partitionViolations acusa regiao que passa da borda inferior', () => {
    const group = new MosaicTileGroup(0, 0, WA);
    group.setMember(8, { window: { id: 8 }, region: { x: 0, y: 32, width: 960, height: 1100 } });

    assert.deepEqual(group.partitionViolations().map(v => v.windowId), [8]);
});

test('sem predicado, todo membro particiona', () => {
    const group = new MosaicTileGroup(0, 0, WA);
    group.setMember(9, { window: { id: 9 }, region: { x: 1800, y: 32, width: 400, height: 1048 } });

    assert.deepEqual(group.partitionViolations().map(v => v.windowId), [9]);
});

test('o predicado isenta quem ele diz', () => {
    const group = new MosaicTileGroup(0, 0, WA);
    group.setMember(9, { window: { id: 9, mini: true }, region: { x: 1800, y: 32, width: 400, height: 1048 } });
    group.setMember(7, { window: { id: 7 }, region: { x: 1800, y: 32, width: 400, height: 1048 } });

    const violations = group.partitionViolations(w => w.mini === true);
    assert.deepEqual(violations.map(v => v.windowId), [7]);
});

// Fed a work area that spreads to {}, every bound became undefined and the check passed
// everything, so this guards the detector itself rather than the geometry.
test('partitionViolations ainda acusa com work area que nao sobrevive a spread', () => {
    const wa = Object.create({ x: 0, y: 32, width: 1920, height: 1048 });
    const group = new MosaicTileGroup(0, 0, wa);
    group.setMember(8, { window: { id: 8 }, region: { x: 1800, y: 32, width: 400, height: 1048 } });

    assert.deepEqual(group.partitionViolations().map(v => v.windowId), [8]);
});


// setMember rebuilds the member, and every retile and every learn() goes through it. Dropping
// the minimum there would silently undo everything the window taught us.
// The defect this whole model exists to prevent: a window sitting at 700px was treated as needing
// 700px, so a split that would have worked got refused. Nothing was ever asked of it.
// The measured case: a text editor that would not go under 616 and a calculator that stops at
// 200, sharing a 768 column. They overlapped by 48px because nobody asked first.
// Refusing on ignorance would deny every first encounter, and a denial that is wrong is worse
// than the overlap it replaces.
// The Cartridges case: it would have fitted, but 50/50 asked it to go under its floor and the
// calculator next to it had room to give.
// A gap of a pixel between the tiles is the same defect as an overlap, just quieter.
// The unknown one takes the leftover, which is the only honest answer: we have no evidence it
// needs more, and refusing would be a guess in the harmful direction.
test('o store devolve o mesmo grupo para o mesmo par workspace/monitor', () => {
    const store = new MosaicTileGroupStore();
    const a = store.ensureGroup(0, 0, WA);
    const b = store.ensureGroup(0, 0, WA);
    assert.equal(a, b);
    assert.notEqual(a, store.ensureGroup(0, 1, WA));
    assert.notEqual(a, store.ensureGroup(1, 0, WA));
});

test('ensureGroup atualiza a work area sem perder membros', () => {
    const store = new MosaicTileGroupStore();
    store.setMember(0, 0, WA, 7, { window: { id: 7 }, region: { x: 0, y: 32, width: 960, height: 1048 } });

    const wider = { x: 0, y: 32, width: 2560, height: 1048 };
    const group = store.ensureGroup(0, 0, wider);

    assert.equal(group.size, 1);
    assert.equal(group.workArea.width, 2560);
});

test('ensureGroup sem work area preserva a que o grupo ja tinha', () => {
    const store = new MosaicTileGroupStore();
    store.ensureGroup(0, 0, WA);

    assert.equal(store.ensureGroup(0, 0, null).workArea.width, 1920);
});

test('groupOfWindow encontra a janela sem saber o workspace', () => {
    const store = new MosaicTileGroupStore();
    store.setMember(2, 1, WA, 7, { window: { id: 7 }, region: { x: 0, y: 32, width: 960, height: 1048 } });

    assert.equal(store.groupOfWindow(7).workspaceIndex, 2);
    assert.equal(store.groupOfWindow(7).monitor, 1);
    assert.equal(store.groupOfWindow(404), null);
});

test('removeWindow tira o membro e o indice reverso', () => {
    const store = new MosaicTileGroupStore();
    store.setMember(0, 0, WA, 7, { window: { id: 7 }, region: { x: 0, y: 32, width: 960, height: 1048 } });

    store.removeWindow(7);

    assert.equal(store.groupOfWindow(7), null);
    assert.equal(store.ensureGroup(0, 0, WA).size, 0);
});

test('mover a janela de grupo nao a deixa nos dois', () => {
    const store = new MosaicTileGroupStore();
    const region = { x: 0, y: 32, width: 960, height: 1048 };
    store.setMember(0, 0, WA, 7, { window: { id: 7 }, region });
    store.setMember(1, 0, WA, 7, { window: { id: 7 }, region });

    assert.equal(store.ensureGroup(0, 0, WA).size, 0);
    assert.equal(store.groupOfWindow(7).workspaceIndex, 1);
});

test('splitAlongAxis particiona a work area no eixo x', () => {
    const wa = { x: 100, y: 50, width: 1000, height: 600 };
    const [a, b] = splitAlongAxis(wa, 'x', 400, 600);

    assert.deepEqual(a, { x: 100, y: 50, width: 400, height: 600 });
    assert.deepEqual(b, { x: 500, y: 50, width: 600, height: 600 });
});

test('splitAlongAxis particiona a work area no eixo y', () => {
    const wa = { x: 100, y: 50, width: 1000, height: 600 };
    const [a, b] = splitAlongAxis(wa, 'y', 200, 400);

    assert.deepEqual(a, { x: 100, y: 50, width: 1000, height: 200 });
    assert.deepEqual(b, { x: 100, y: 250, width: 1000, height: 400 });
});

// A Mtk.Rectangle keeps x/y/width/height on the prototype, so spreading one yields {} and
// every field silently becomes undefined. Anything reading a work area has to go field by field.
test('splitAlongAxis le uma work area que nao sobrevive a spread', () => {
    const wa = Object.create({ x: 0, y: 32, width: 1280, height: 768 });
    assert.deepEqual({ ...wa }, {});

    const [a, b] = splitAlongAxis(wa, 'y', 384, 384);

    assert.deepEqual(a, { x: 0, y: 32, width: 1280, height: 384 });
    assert.deepEqual(b, { x: 0, y: 416, width: 1280, height: 384 });
});

test('splitAlongAxis nao deixa lacuna nem sobreposicao', () => {
    const wa = { x: 0, y: 0, width: 900, height: 700 };
    const [a, b] = splitAlongAxis(wa, 'x', 300, 600);

    assert.equal(a.width + b.width, wa.width);
    assert.equal(a.x + a.width, b.x);
});
