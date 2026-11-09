import { describe, expect, it } from 'vitest';
import { configuredModelReasoningDefault } from '../types';

describe('configured model reasoning default', () => {
  it('preserves a legacy default when no nested key exists', () => {
    expect(configuredModelReasoningDefault({ configuration: {}, defaultReasoningEffort: 'high' })).toBe('high');
  });
  it.each([null, '', ' ', 'invalid'])('does not revive legacy High for nested %s', value => {
    expect(configuredModelReasoningDefault({ configuration: { defaultReasoningEffort: value }, defaultReasoningEffort: 'high' })).toBeNull();
  });
  it('displays legacy none as Low', () => {
    expect(configuredModelReasoningDefault({ configuration: { defaultReasoningEffort: 'none' } })).toBe('low');
  });
});
