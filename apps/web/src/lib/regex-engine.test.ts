import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  RegexPlacement,
  applyRegexScripts,
  applyRegexScriptsBounded,
  normalizeRegexScript,
  type RegexScript
} from './regex-engine';

afterEach(() => vi.unstubAllGlobals());

const script = (overrides: Partial<RegexScript> = {}): RegexScript => ({
  id: 'script-1',
  scriptName: 'remove thoughts',
  findRegex: '/<think>[\\s\\S]*?<\\/think>/gi',
  replaceString: '',
  trimStrings: [],
  placement: [RegexPlacement.AI_OUTPUT],
  disabled: false,
  markdownOnly: false,
  promptOnly: false,
  runOnEdit: true,
  substituteRegex: 0,
  minDepth: null,
  maxDepth: null,
  ...overrides
});

describe('SillyTavern-compatible regex pipeline', () => {
  it('does not start a Worker or report a timeout when no script can run', async () => {
    const WorkerStub = vi.fn(() => {
      throw new Error('Worker must not start without a runnable script');
    });
    vi.stubGlobal('Worker', WorkerStub);

    await expect(applyRegexScriptsBounded('hello', [], {
      placement: RegexPlacement.USER_INPUT,
      macros: { user: 'User', char: 'Character' }
    })).resolves.toEqual({ text: 'hello', timedOut: false });
    expect(WorkerStub).not.toHaveBeenCalled();
  });

  it('runs only scripts assigned to the current placement', () => {
    expect(
      applyRegexScripts('hello <think>secret</think> world', [script()], {
        placement: RegexPlacement.AI_OUTPUT,
        macros: { user: '林岸', char: '流萤' }
      })
    ).toBe('hello  world');
    expect(
      applyRegexScripts('hello <think>secret</think> world', [script()], {
        placement: RegexPlacement.USER_INPUT,
        macros: { user: '林岸', char: '流萤' }
      })
    ).toContain('secret');
  });

  it('supports capture groups, trim strings, {{match}}, and replacement macros', () => {
    const replacement = script({
      findRegex: '/Name: (.+)/',
      replaceString: '{{char}}=$1/{{match}}',
      trimStrings: ['!']
    });
    expect(
      applyRegexScripts('Name: Firefly!', [replacement], {
        placement: RegexPlacement.AI_OUTPUT,
        macros: { user: '林岸', char: '流萤' }
      })
    ).toBe('流萤=Firefly/Name: Firefly!');
  });

  it('normalizes the SillyTavern JSON shape and leaves imported scripts disabled', () => {
    expect(
      normalizeRegexScript({
        id: 'st-1',
        scriptName: 'cleanup',
        findRegex: '/foo/g',
        replaceString: 'bar',
        placement: [2]
      }, { trusted: false })
    ).toMatchObject({
      id: 'st-1',
      findRegex: '/foo/g',
      placement: [RegexPlacement.AI_OUTPUT],
      disabled: true
    });
  });

  it('rejects obvious nested-quantifier patterns instead of running them', () => {
    expect(
      applyRegexScripts('aaaaaaaaaaaaaaaa!', [
        script({ findRegex: '/(a+)+$/' })
      ], {
        placement: RegexPlacement.AI_OUTPUT,
        macros: { user: '林岸', char: '流萤' }
      })
    ).toBe('aaaaaaaaaaaaaaaa!');
  });
});
