import { beforeEach, describe, expect, it } from 'vitest';
import {
  exportPersonas,
  importPersonas,
  listPersonas,
  setDefaultPersona
} from './persona';
import { resetLoreDatabaseForTests } from './lore-store';

beforeEach(async () => {
  await resetLoreDatabaseForTests();
});

describe('player Persona interchange', () => {
  it('imports the SillyTavern personas/persona_descriptions settings shape', async () => {
    const result = await importPersonas({
      personas: {
        'lin-an.png': '林岸',
        'shen-chi.png': '沈迟'
      },
      persona_descriptions: {
        'lin-an.png': { description: '夜班记者。', title: '记者' },
        'shen-chi.png': { description: '外科医生。' }
      },
      default_persona: 'lin-an.png'
    });
    expect(result).toMatchObject({ added: 2, missing_avatars: 2 });
    const personas = await listPersonas();
    expect(personas.map((item) => [item.name, item.description])).toEqual([
      ['林岸', '夜班记者。'],
      ['沈迟', '外科医生。']
    ]);
  });

  it('round-trips ST fields and keeps one explicit default', async () => {
    await importPersonas({
      personas: { 'lin.png': '林岸', 'shen.png': '沈迟' },
      persona_descriptions: {
        'lin.png': {
          description: '记者',
          position: 'AT_DEPTH',
          depth: 3,
          role: 'user',
          future_field: 'keep'
        },
        'shen.png': { description: '' }
      }
    });
    const second = (await listPersonas()).find((item) => item.name === '沈迟');
    await setDefaultPersona(second?.persona_id ?? null);
    const exported = await exportPersonas();
    expect(exported.default_persona).toBe('shen.png');
    expect(exported.personas).toMatchObject({
      'lin.png': '林岸',
      'shen.png': '沈迟'
    });
    expect(exported.persona_descriptions).toMatchObject({
      'lin.png': {
        description: '记者',
        position: 'AT_DEPTH',
        depth: 3,
        role: 'user',
        future_field: 'keep'
      }
    });
  });
});
