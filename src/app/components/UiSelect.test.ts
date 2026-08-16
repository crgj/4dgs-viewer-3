import { describe, expect, it } from 'vitest';
import { calculateUiSelectPopoverPosition } from './UiSelect';

describe('UiSelect popover placement', () => {
  it('right-aligns an above popover and keeps it inside the viewport', () => {
    expect(calculateUiSelectPopoverPosition(
      { bottom: 700, right: 990, top: 676, width: 58 },
      7,
      'above',
      1000,
      720,
    )).toEqual({ left: 904, top: 485, width: 86 });
  });

  it('clamps a below popover away from viewport edges', () => {
    expect(calculateUiSelectPopoverPosition(
      { bottom: 32, right: 54, top: 8, width: 48 },
      2,
      'below',
      320,
      200,
    )).toEqual({ left: 8, top: 38, width: 86 });
  });
});
