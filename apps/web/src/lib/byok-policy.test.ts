import { describe, expect, it } from 'vitest';
import { ByokCompatibilityError, validateByokBaseUrl } from './byok-policy';

describe('BYOK connection policy', () => {
  it('accepts built-in provider origins', () => {
    expect(validateByokBaseUrl('https://api.openai.com/v1').origin)
      .toBe('https://api.openai.com');
  });

  it('accepts only explicitly configured custom origins', () => {
    expect(validateByokBaseUrl('https://models.example.test/v1', {
      extraOrigins: 'https://models.example.test'
    }).origin).toBe('https://models.example.test');
    expect(() => validateByokBaseUrl('https://other.example.test/v1', {
      extraOrigins: 'https://models.example.test'
    })).toThrowError(ByokCompatibilityError);
  });

  it('classifies mixed content as permanently incompatible', () => {
    try {
      validateByokBaseUrl('http://models.example.test/v1', {
        extraOrigins: 'http://models.example.test', pageProtocol: 'https:'
      });
      throw new Error('expected validation to fail');
    } catch (reason) {
      expect(reason).toMatchObject({ code: 'BYOK_MIXED_CONTENT', retryable: false });
    }
  });
});
