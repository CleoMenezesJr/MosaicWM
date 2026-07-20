import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MosaicModel, ComputedLayouts } from '../extension/mosaicModel.js';
import * as WindowState from '../extension/windowState.js';
import { IS_MINIATURE } from '../extension/windowState.js';

const workspace = index => ({ index: () => index });
const fakeWindow = (id, frame = null) => ({
    get_id: () => id,
    get_frame_rect: () => frame,
    get_workspace: () => workspace(0),
    get_monitor: () => 0,
});

test('setRegion e regionFor mantem o contrato', () => {
    MosaicModel.clear();
    const win = fakeWindow(7);
    MosaicModel.setRegion(win, { x: 10, y: 20, width: 300, height: 400 }, workspace(0), 0);

    assert.deepEqual(MosaicModel.regionFor(win), { x: 10, y: 20, width: 300, height: 400 });
});

test('geometryOf prefere a regiao ao frame vivo', () => {
    MosaicModel.clear();
    const win = fakeWindow(7, { x: 999, y: 999, width: 1, height: 1 });
    MosaicModel.setRegion(win, { x: 10, y: 20, width: 300, height: 400 }, workspace(0), 0);

    assert.deepEqual(MosaicModel.geometryOf(win), { x: 10, y: 20, width: 300, height: 400 });
});

test('geometryOf cai no frame vivo quando nao ha regiao', () => {
    MosaicModel.clear();
    const win = fakeWindow(7, { x: 5, y: 6, width: 7, height: 8 });

    assert.deepEqual(MosaicModel.geometryOf(win), { x: 5, y: 6, width: 7, height: 8 });
});

test('learn substitui a regiao pelo frame real', () => {
    MosaicModel.clear();
    const win = fakeWindow(7);
    MosaicModel.setRegion(win, { x: 10, y: 20, width: 300, height: 400 }, workspace(0), 0);
    MosaicModel.learn(win, { x: 10, y: 20, width: 320, height: 400 });

    assert.equal(MosaicModel.regionFor(win).width, 320);
});

test('learn ignora janela que nao e membro', () => {
    MosaicModel.clear();
    MosaicModel.learn(fakeWindow(7), { x: 0, y: 0, width: 1, height: 1 });

    assert.equal(MosaicModel.regionFor(fakeWindow(7)), null);
});

test('forget tira a janela do grupo', () => {
    MosaicModel.clear();
    const win = fakeWindow(7);
    MosaicModel.setRegion(win, { x: 10, y: 20, width: 300, height: 400 }, workspace(0), 0);
    MosaicModel.forget(win);

    assert.equal(MosaicModel.regionFor(win), null);
    assert.deepEqual(MosaicModel.store.groupFor(0, 0).members(), []);
});

test('o modelo guarda regiao e nada mais sobre a janela', () => {
    MosaicModel.clear();
    const win = fakeWindow(9);
    WindowState.set(win, IS_MINIATURE, true);

    MosaicModel.setRegion(win, { x: 0, y: 0, width: 800, height: 600 }, workspace(0), 0);

    const member = MosaicModel.store.groupOfWindow(9).memberOf(9);
    assert.deepEqual(member.region, { x: 0, y: 0, width: 800, height: 600 });
    assert.equal(member.kind, undefined);
    assert.equal(member.scale, undefined);
});

test('ComputedLayouts continua sendo fachada do mesmo store', () => {
    MosaicModel.clear();
    const win = fakeWindow(7);
    ComputedLayouts.set(win, { x: 1, y: 2, width: 3, height: 4 });

    assert.deepEqual(ComputedLayouts.get(win), { x: 1, y: 2, width: 3, height: 4 });
    ComputedLayouts.delete(win);
    assert.equal(ComputedLayouts.get(win), undefined);
});
