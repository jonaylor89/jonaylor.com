import { describe, expect, it } from 'vitest';
import { checksum, deserializeSave, serializeSave } from '../src/game/save';
import { newGameState } from '../src/game/state';
import type { GameBundle } from '../src/data/schema';

const state = () => newGameState({ toggleableObjects: [] } as unknown as GameBundle);
describe('untrusted save structure', () => {
  it.each(['null', '[]', '{}', '{"format":"pokeyellow-web-save"}'])('rejects malformed envelope %s', text => {
    expect(() => deserializeSave(text)).toThrow();
  });
  it('rejects a checksummed but unusable state', () => {
    const file = JSON.parse(serializeSave(state()));
    file.state.party = Array.from({ length: 7 }, () => ({}));
    file.checksum = checksum(JSON.stringify(file.state));
    expect(() => deserializeSave(JSON.stringify(file))).toThrow('malformed');
  });
  it('migrates structurally valid version-one saves', () => {
    const file = JSON.parse(serializeSave(state()));
    file.version = 1; file.state.version = 1; delete file.state.vars;
    file.checksum = checksum(JSON.stringify(file.state));
    expect(deserializeSave(JSON.stringify(file)).state.vars).toEqual({});
  });
  it('enforces byte bounds before parsing', () => {
    expect(() => deserializeSave('x'.repeat(1048577))).toThrow('1 MiB');
  });
});
