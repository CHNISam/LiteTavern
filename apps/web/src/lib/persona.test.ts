import { beforeEach, describe, expect, it } from 'vitest';
import {
  exportPersonas,
  importPersonas,
  listPersonas,
  setDefaultPersona,
  draftFromCharacterCard
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

  it('handles numeric SillyTavern enum imports for position and role', async () => {
    await importPersonas({
      personas: { 'test.png': 'Tester' },
      persona_descriptions: {
        'test.png': {
          description: 'Testing numeric enums.',
          position: 4,
          role: 1
        }
      }
    });
    const personas = await listPersonas();
    expect(personas[0]).toMatchObject({
      position: 'AT_DEPTH',
      role: 'user'
    });
  });

  it('resolves duplicate names via numeric suffix', async () => {
    await importPersonas({
      personas: { 'a.png': 'Name' },
      persona_descriptions: { 'a.png': { description: 'First' } }
    });
    await importPersonas({
      personas: { 'b.png': 'Name', 'c.png': 'Name (2)' },
      persona_descriptions: {
        'b.png': { description: 'Second' },
        'c.png': { description: 'Third' }
      }
    });
    
    // We should get Name, Name (2) generated for the first batch
    // and Name (2), Name (3) generated for the second batch
    // Because Name (2) is claimed in existing, it skips it for 'b' and makes it Name (3) (Wait, let's see how Set behaves)
    const personas = await listPersonas();
    const sorted = personas.map((p) => p.name).sort();
    expect(sorted).toEqual(['Name', 'Name (2)', 'Name (3)']);
  });
});

describe('draftFromCharacterCard', () => {
  it('extracts fundamental persona details & swaps {{user}} / {{char}}', () => {
    const draft = draftFromCharacterCard({
      name: 'CharName',
      description: '{{char}} is cool. {{char}} likes {{user}}.',
      personality: '{{user}} sees {{char}} as a friend.'
    });

    expect(draft).toMatchObject({
      name: 'CharName',
      description: '{{user}} is cool. {{user}} likes {{char}}.\n\n{{char}} sees {{user}} as a friend.',
      position: 'IN_PROMPT',
      role: 'system'
    });
  });
});
