'use client';

import { useFormFieldControl } from './form-field';

export function EntityDescriptionInput({ value, onChange, canEdit, placeholder, maxLength }: {
  value: string;
  onChange: (value: string) => void;
  canEdit: boolean;
  placeholder?: string;
  maxLength?: number;
}) {
  const control = useFormFieldControl();
  return (
    <textarea
      {...control}
      value={value}
      readOnly={!canEdit}
      maxLength={maxLength}
      onChange={(event) => { if (canEdit) onChange(event.target.value); }}
      placeholder={canEdit ? placeholder : ''}
      rows={4}
      style={{
        width: '100%', minHeight: 88, padding: '10px 12px',
        backgroundColor: 'var(--color-surface)', border: '1px solid var(--slate-a5)',
        borderRadius: 'var(--radius-2)', fontSize: 14, lineHeight: '20px',
        fontFamily: 'var(--default-font-family)', color: 'var(--slate-12)',
        outline: 'none', boxSizing: 'border-box', resize: 'vertical',
        cursor: canEdit ? 'text' : 'default',
      }}
      onFocus={(event) => {
        if (canEdit) {
          event.currentTarget.style.border = '2px solid var(--accent-8)';
          event.currentTarget.style.padding = '9px 11px';
        }
      }}
      onBlur={(event) => {
        event.currentTarget.style.border = '1px solid var(--slate-a5)';
        event.currentTarget.style.padding = '10px 12px';
      }}
    />
  );
}
