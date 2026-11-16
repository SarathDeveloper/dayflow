import { useState } from 'react';
import { Button } from './ui/Button';
import { Card } from './ui/Card';
import { todayString } from '../lib/ledger';

interface ServiceRecord {
  date: string;
  notes: string;
}

interface MaintenanceItem {
  id: string;
  asset: string;
  kind: 'vehicle' | 'home';
  title: string;
  due: string;
  intervalMonths: number;
  history: ServiceRecord[];
}

const storageKey = 'dayflow_maintenance_v1';
const inputClass = 'w-full rounded-xl border border-slate-300 p-3 text-slate-900 dark:border-slate-700 dark:bg-slate-900 dark:text-white';

export function nextMaintenanceDate(date: string, months: number): string {
  const [year, month, day] = date.split('-').map(Number);
  const target = new Date(year, month - 1 + months, 1, 12);
  const lastDay = new Date(target.getFullYear(), target.getMonth() + 1, 0, 12).getDate();
  target.setDate(Math.min(day, lastDay));
  return [target.getFullYear(), String(target.getMonth() + 1).padStart(2, '0'), String(target.getDate()).padStart(2, '0')].join('-');
}

export default function MaintenanceView() {
  const [error, setError] = useState('');
  const [items, setItems] = useState<MaintenanceItem[]>(() => {
    try {
      const value = JSON.parse(localStorage.getItem(storageKey) ?? '[]');
      if (!Array.isArray(value)) throw new Error();
      return value;
    } catch {
      return [];
    }
  });
  const [asset, setAsset] = useState('');
  const [kind, setKind] = useState<'vehicle' | 'home'>('vehicle');
  const [title, setTitle] = useState('');
  const [due, setDue] = useState(todayString());
  const [interval, setInterval] = useState(6);
  const [editing, setEditing] = useState(false);
  const [completing, setCompleting] = useState<string>();
  const [completedDate, setCompletedDate] = useState(todayString());
  const [notes, setNotes] = useState('');

  function save(next: MaintenanceItem[]): boolean {
    try {
      localStorage.setItem(storageKey, JSON.stringify(next));
      setItems(next);
      setError('');
      return true;
    } catch {
      setError('Could not save maintenance records. Keep this screen open and try again.');
      return false;
    }
  }

  return <section className="mx-auto max-w-2xl space-y-4">
    <div className="flex flex-wrap justify-between gap-3">
      <h2 className="text-xl font-bold">Vehicle and Home Maintenance</h2>
      <Button onClick={() => setEditing(true)}>Add maintenance</Button>
    </div>
    <p className="text-sm text-slate-500">Maintenance records are saved on this device.</p>
    {error && <p role="alert" className="text-rose-600">{error}</p>}
    {editing && <Card className="p-4">
      <form className="space-y-3" onSubmit={(event) => {
        event.preventDefault();
        if (!asset.trim() || !title.trim()) return;
        if (save([...items, { id: crypto.randomUUID(), asset: asset.trim(), kind, title: title.trim(), due, intervalMonths: interval, history: [] }])) {
          setEditing(false);
          setAsset('');
          setTitle('');
        }
      }}>
        <label className="block">Type<select className={inputClass} value={kind} onChange={(event) => setKind(event.target.value as 'vehicle' | 'home')}>
          <option value="vehicle">Vehicle</option><option value="home">Home</option>
        </select></label>
        <label className="block">Vehicle or appliance<input required maxLength={200} className={inputClass} value={asset} onChange={(event) => setAsset(event.target.value)} /></label>
        <label className="block">Maintenance task<input required maxLength={200} className={inputClass} value={title} onChange={(event) => setTitle(event.target.value)} /></label>
        <label className="block">Next due date<input required type="date" className={inputClass} value={due} onChange={(event) => setDue(event.target.value)} /></label>
        <label className="block">Repeat every months<input required type="number" min={1} max={120} className={inputClass} value={interval} onChange={(event) => setInterval(Number(event.target.value))} /></label>
        <div className="flex gap-2"><Button type="submit">Save</Button><Button type="button" variant="ghost" onClick={() => setEditing(false)}>Cancel</Button></div>
      </form>
    </Card>}
    {!items.length && <Card className="p-4">Add a vehicle service, filter replacement, or another recurring maintenance task.</Card>}
    {[...items].sort((a, b) => a.due.localeCompare(b.due)).map((item) => <Card key={item.id} className="space-y-3 p-4">
      <h3 className="font-bold">{item.asset} · {item.title}</h3>
      <p className={item.due < todayString() ? 'text-rose-600' : 'text-slate-500'}>{item.due < todayString() ? 'Overdue' : 'Due'} {item.due} · Every {item.intervalMonths} months</p>
      {completing === item.id ? <form className="space-y-3" onSubmit={(event) => {
        event.preventDefault();
        const next = items.map((record) => record.id === item.id ? {
          ...record,
          due: nextMaintenanceDate(completedDate, record.intervalMonths),
          history: [...record.history, { date: completedDate, notes }],
        } : record);
        if (save(next)) { setCompleting(undefined); setNotes(''); }
      }}>
        <label className="block">Completed date<input required type="date" max={todayString()} className={inputClass} value={completedDate} onChange={(event) => setCompletedDate(event.target.value)} /></label>
        <label className="block">Service notes<textarea maxLength={4000} className={inputClass} value={notes} onChange={(event) => setNotes(event.target.value)} /></label>
        <div className="flex gap-2"><Button type="submit">Record service</Button><Button type="button" variant="ghost" onClick={() => setCompleting(undefined)}>Cancel</Button></div>
      </form> : <Button variant="secondary" onClick={() => { setCompleting(item.id); setCompletedDate(todayString()); setNotes(''); }}>Mark serviced</Button>}
      {!!item.history.length && <details><summary>Service history</summary><ul className="mt-2 space-y-2">{[...item.history].reverse().map((record, index) => <li key={index} className="whitespace-pre-wrap text-sm">{record.date} {record.notes}</li>)}</ul></details>}
    </Card>)}
  </section>;
}
