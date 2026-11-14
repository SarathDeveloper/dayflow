import type { DiaryEntry, DiaryImage, DiaryMood, HabitColor, DiaryReflection } from '../types';
import { habitColor, type HabitColorClasses } from './habitStyle';

export const DIARY_MOODS: { id: DiaryMood; label: string }[] = [
  { id: 'great', label: 'Great' },
  { id: 'good', label: 'Good' },
  { id: 'okay', label: 'Okay' },
  { id: 'low', label: 'Low' },
  { id: 'rough', label: 'Rough' },
];

const MOOD_COLOR: Record<DiaryMood, HabitColor> = {
  great: 'emerald',
  good: 'sky',
  okay: 'amber',
  low: 'violet',
  rough: 'rose',
};

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;

/** Photos kept on one note. Extra picks are refused. */
export const MAX_DIARY_IMAGES = 4;

/** Rough cap for the whole diary in localStorage, in JSON characters. */
export const MAX_DIARY_STORAGE_CHARS = 4_500_000;

export interface DiaryDraft {
  date: string;
  time: string;
  mood: string;
  body: string;
  imageCount?: number;
}

export function isDiaryMood(value: string): value is DiaryMood {
  return DIARY_MOODS.some((mood) => mood.id === value);
}

export function diaryMoodLabel(mood: DiaryMood): string {
  return DIARY_MOODS.find((item) => item.id === mood)?.label ?? 'Okay';
}

export function diaryMoodColor(mood: DiaryMood): HabitColorClasses {
  return habitColor(MOOD_COLOR[mood]);
}

export function currentTimeString(now: Date = new Date()): string {
  return `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
}

/** Returns an error message, or null when the draft can be saved. */
export function validateDiaryDraft(draft: DiaryDraft): string | null {
  if (!DATE_PATTERN.test(draft.date)) return 'Choose a valid date.';
  const [year, month, day] = draft.date.split('-').map(Number);
  const parsed = new Date(year, month - 1, day);
  if (parsed.getFullYear() !== year || parsed.getMonth() !== month - 1 || parsed.getDate() !== day) {
    return 'Choose a valid date.';
  }
  if (!TIME_PATTERN.test(draft.time)) return 'Choose a valid time.';
  if (!isDiaryMood(draft.mood)) return 'Choose a mood.';
  const imageCount = draft.imageCount ?? 0;
  if (imageCount > MAX_DIARY_IMAGES) return `A note can hold up to ${MAX_DIARY_IMAGES} photos.`;
  if (!draft.body.trim() && imageCount === 0) return 'Write a note or add a photo before saving.';
  return null;
}

/** Drops anything that is not a stored photo and keeps at most `MAX_DIARY_IMAGES`. */
export function sanitizeDiaryImages(images: DiaryImage[] | undefined): DiaryImage[] {
  if (!Array.isArray(images)) return [];
  const clean: DiaryImage[] = [];
  for (const image of images) {
    if (!image || typeof image.id !== 'string' || !image.id) continue;
    if (typeof image.dataUrl !== 'string' || !image.dataUrl.startsWith('data:image/')) continue;
    clean.push({ id: image.id, dataUrl: image.dataUrl });
    if (clean.length >= MAX_DIARY_IMAGES) break;
  }
  return clean;
}

export function diaryCollectionFits(entries: DiaryEntry[]): boolean {
  return JSON.stringify(entries).length <= MAX_DIARY_STORAGE_CHARS;
}

/** Latest clock time first. Equal times keep the newer edit first. */
export function sortDiaryEntries(entries: DiaryEntry[]): DiaryEntry[] {
  return [...entries].sort((a, b) => {
    const byTime = b.time.localeCompare(a.time);
    if (byTime !== 0) return byTime;
    return b.updatedAt.localeCompare(a.updatedAt);
  });
}

export function groupDiaryByDate(entries: DiaryEntry[]): { date: string; entries: DiaryEntry[] }[] {
  const byDate = new Map<string, DiaryEntry[]>();
  for (const entry of entries) {
    const list = byDate.get(entry.date) ?? [];
    list.push(entry);
    byDate.set(entry.date, list);
  }
  return [...byDate.entries()]
    .sort(([a], [b]) => b.localeCompare(a))
    .map(([date, dayEntries]) => ({ date, entries: sortDiaryEntries(dayEntries) }));
}

export function searchDiaryEntries(entries: DiaryEntry[], query: string): DiaryEntry[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return entries;
  return entries.filter((entry) => entry.body.toLowerCase().includes(needle));
}

/** First non-empty line, shortened for cards and the calendar. */
export function diaryPreview(body: string, max = 80): string {
  const line = body
    .split(/\r?\n/)
    .map((part) => part.trim())
    .find((part) => part.length > 0) ?? '';
  if (line.length <= max) return line;
  return `${line.slice(0, max - 1).trimEnd()}…`;
}

// ---------------------------------------------------------------------------
// Evening reflection
// ---------------------------------------------------------------------------

export const ENERGY_LEVELS: { value: number; label: string }[] = [
  { value: 1, label: 'Drained' },
  { value: 2, label: 'Low' },
  { value: 3, label: 'Steady' },
  { value: 4, label: 'Good' },
  { value: 5, label: 'Full of energy' },
];

export function energyLabel(value: number | undefined): string | null {
  return ENERGY_LEVELS.find((level) => level.value === value)?.label ?? null;
}

export const REFLECTION_PROMPTS: { key: keyof DiaryReflection; question: string; heading: string }[] = [
  { key: 'wentWell', question: 'What went well today?', heading: 'Went well' },
  { key: 'missed', question: 'What did I fail to complete?', heading: 'Didn’t finish' },
  { key: 'learned', question: 'What did I learn?', heading: 'Learned' },
  { key: 'improve', question: 'What should I improve tomorrow?', heading: 'Improve tomorrow' },
];

/** Trimmed answers; empty ones are dropped. */
export function cleanReflection(reflection: DiaryReflection): DiaryReflection {
  const clean: DiaryReflection = {};
  for (const { key } of REFLECTION_PROMPTS) {
    const value = reflection[key]?.trim();
    if (value) clean[key] = value;
  }
  return clean;
}

/** The diary text for an evening review, so it reads well anywhere notes are shown. */
export function composeReflectionBody(reflection: DiaryReflection): string {
  const clean = cleanReflection(reflection);
  const lines = REFLECTION_PROMPTS.filter(({ key }) => clean[key]).map(({ key, heading }) => `${heading}: ${clean[key]}`);
  return lines.length > 0 ? lines.join('\n') : 'Evening review';
}

/** The evening-review entry of a day, if one was saved. */
export function reflectionFor(entries: DiaryEntry[], date: string): DiaryEntry | undefined {
  return entries.find((entry) => entry.date === date && entry.reflection);
}
