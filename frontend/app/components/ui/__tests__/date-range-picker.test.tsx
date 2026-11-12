import React from 'react';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {cleanup,fireEvent,render,screen} from '@testing-library/react';
import {Theme} from '@radix-ui/themes';
import {DateRangePicker} from '../date-range-picker';

vi.mock('react-i18next',async(importOriginal)=>({...await importOriginal<typeof import('react-i18next')>(),useTranslation:()=>({t:(key:string)=>key,i18n:{language:'en-US'}})}));
beforeEach(()=>{vi.useFakeTimers({toFake:['Date']});vi.setSystemTime(new Date('2026-11-08T12:00:00Z'));});
afterEach(()=>{cleanup();vi.useRealTimers();});

describe('shared date picker',()=>{
  it('applies a range through accessible calendar buttons',async()=>{
    const onApply=vi.fn();
    render(<Theme><DateRangePicker label="Range" dateType="between" fixedDateType="between" onApply={onApply} onClear={()=>{}} /></Theme>);
    fireEvent.click(screen.getByRole('button',{name:'Range',exact:true}));
    fireEvent.click(await screen.findByRole('button',{name:'Sunday, November 8, 2026'}));
    fireEvent.click(screen.getByRole('button',{name:'Tuesday, November 10, 2026'}));
    fireEvent.click(screen.getByRole('button',{name:'datePicker.apply'}));
    expect(onApply).toHaveBeenCalledWith('2026-11-08','2026-11-10','between');
  });
  it('opens the date-only anchor month and retains a selected time',async()=>{
    const onApply=vi.fn(),onClear=vi.fn();
    render(<Theme><DateRangePicker label="Starts" startDate="2026-11-01T09:30" dateType="on" fixedDateType="on" withTime onApply={onApply} onClear={onClear} /></Theme>);
    fireEvent.click(screen.getByRole('button',{name:/^Starts:/}));
    expect(await screen.findByText('November 2026')).toBeTruthy();
    fireEvent.click(screen.getByRole('button',{name:'Sunday, November 8, 2026'}));
    fireEvent.click(screen.getByRole('button',{name:'datePicker.apply'}));
    expect(onApply).toHaveBeenCalledWith('2026-11-08T09:30',undefined,'on');
    fireEvent.click(screen.getByRole('button',{name:'common.clear Starts'}));
    expect(onClear).toHaveBeenCalledOnce();
  });
});
