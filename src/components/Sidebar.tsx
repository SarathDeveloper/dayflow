import React, { useEffect, useRef } from 'react';
import {
  AlarmClock,
  BookOpen,
  Calendar,
  CalendarDays,
  Clock,
  FileLock2,
  Folder,
  Home,
  KeyRound,
  Plus,
  Repeat,
  Settings,
  Target,
  TrendingUp,
  Wallet,
  Wrench,
  X,
  Zap,
} from 'lucide-react';
import { ActiveTab } from '../types';
import { hasPasswordVault } from '../services/passwordVault';
import { isNative } from '../lib/platform';

interface NavItem {
  id: ActiveTab;
  label: string;
  icon: React.ElementType;
}

interface NavSection {
  /** Small heading above the items; none for the top (Home) section. */
  title?: string;
  items: NavItem[];
}

function navSections(): NavSection[] {
  return [
    { items: [{ id: 'home', label: 'Home', icon: Home }] },
    {
      title: 'Productivity',
      items: [
        { id: 'today', label: 'Today', icon: Calendar },
        { id: 'calendar', label: 'Calendar', icon: CalendarDays },
        { id: 'timeline', label: 'Timeline', icon: Clock },
        { id: 'focus', label: 'Focus', icon: Zap },
        { id: 'alarms', label: 'Alarms', icon: AlarmClock },
      ],
    },
    {
      title: 'Habits & Goals',
      items: [
        { id: 'habits', label: 'Habits', icon: Repeat },
        { id: 'goals', label: 'Goals', icon: Target },
        { id: 'stats', label: 'Progress', icon: TrendingUp },
        { id: 'diary', label: 'Diary', icon: BookOpen },
      ],
    },
    { title: 'Finance', items: [{ id: 'finance', label: 'Money', icon: Wallet }] },
    { title: 'Assets', items: [{ id: 'maintenance', label: 'Vehicle & Home', icon: Wrench }] },
    {
      title: 'Secure Storage',
      items: [
        { id: 'documents', label: 'Documents', icon: FileLock2 },
        ...(hasPasswordVault() ? [{ id: 'vault' as const, label: 'Password Vault', icon: KeyRound }] : []),
      ],
    },
  ];
}

/** Setup screens, shown below the main sections. */
const CATEGORIES_ITEM: NavItem = { id: 'categories', label: 'Categories', icon: Folder };

const todayLabel = () =>
  new Date().toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });

const Brand: React.FC = () => (
  <div className="flex items-center gap-3 px-1 min-w-0">
    <div className="w-9 h-9 rounded-xl bg-gradient-to-tr from-indigo-600 to-violet-500 flex items-center justify-center text-white shadow-md shadow-indigo-500/20 shrink-0">
      <span className="font-bold text-lg leading-none">✓</span>
    </div>
    <div className="min-w-0">
      <h1 className="font-bold text-base tracking-tight leading-none text-slate-900 dark:text-white">Dayflow</h1>
      <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">{todayLabel()}</p>
    </div>
  </div>
);

const navButtonClass = (isActive: boolean) =>
  // Compact rows from lg (desktop sidebar, mouse); the phone drawer keeps 44px touch targets.
  `flex w-full items-center gap-3 px-3 py-2.5 min-h-11 lg:py-1.5 lg:min-h-9 rounded-xl text-sm font-semibold transition-colors ${
    isActive
      ? 'bg-indigo-50 dark:bg-indigo-950/50 text-indigo-700 dark:text-indigo-300'
      : 'text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800 hover:text-slate-900 dark:hover:text-slate-200'
  }`;

const NavButton: React.FC<{ item: NavItem; activeTab: ActiveTab; onSelect: (tab: ActiveTab) => void }> = ({
  item,
  activeTab,
  onSelect,
}) => {
  const Icon = item.icon;
  const isActive = activeTab === item.id;
  return (
    <button
      type="button"
      onClick={() => onSelect(item.id)}
      aria-current={isActive ? 'page' : undefined}
      className={navButtonClass(isActive)}
    >
      <Icon className={`w-5 h-5 shrink-0 ${isActive ? 'stroke-[2.5px]' : 'stroke-2'}`} />
      <span>{item.label}</span>
    </button>
  );
};

const NavList: React.FC<{ activeTab: ActiveTab; onSelect: (tab: ActiveTab) => void }> = ({ activeTab, onSelect }) => (
  <>
    {navSections().map((section) => {
      const headingId = section.title ? `nav-${section.title.replace(/\W+/g, '-').toLowerCase()}` : undefined;
      return (
        <div
          key={section.title ?? 'top'}
          role="group"
          aria-labelledby={headingId}
          className="flex flex-col gap-1 lg:gap-0.5"
        >
          {section.title && (
            <p
              id={headingId}
              className="px-3 pt-4 pb-1 lg:pt-3 text-[11px] font-semibold uppercase tracking-wider text-slate-400 dark:text-slate-500"
            >
              {section.title}
            </p>
          )}
          {section.items.map((item) => (
            <NavButton key={item.id} item={item} activeTab={activeTab} onSelect={onSelect} />
          ))}
        </div>
      );
    })}
  </>
);

const SettingsButton: React.FC<{ onClick: () => void }> = ({ onClick }) => (
  <button type="button" onClick={onClick} className={navButtonClass(false)}>
    <Settings className="w-5 h-5 shrink-0 stroke-2" />
    <span>Settings</span>
  </button>
);

interface SidebarProps {
  activeTab: ActiveTab;
  onChangeTab: (tab: ActiveTab) => void;
  onOpenQuickAdd: () => void;
}

/** Fixed left navigation on desktop (lg and up). Settings is the header's gear button here. */
export const Sidebar: React.FC<SidebarProps> = ({ activeTab, onChangeTab, onOpenQuickAdd }) => {
  return (
    <aside className="hidden lg:flex fixed left-0 top-0 bottom-0 w-64 z-30 flex-col overflow-hidden bg-white dark:bg-slate-900 border-r border-slate-200 dark:border-slate-800 px-4 py-5 select-none">
      <div className="mb-4 shrink-0">
        <Brand />
      </div>

      <nav aria-label="Main" className="flex flex-col gap-0.5 flex-1 min-h-0 overflow-y-auto">
        <NavList activeTab={activeTab} onSelect={onChangeTab} />
      </nav>

      <div className="shrink-0 mt-2 pt-2 border-t border-slate-200 dark:border-slate-800">
        <NavButton item={CATEGORIES_ITEM} activeTab={activeTab} onSelect={onChangeTab} />
      </div>

      {/* New Task / Finance entry button (replaces FAB on desktop) */}
      {activeTab !== 'vault' && <button
        onClick={onOpenQuickAdd}
        className="mt-4 w-full shrink-0 inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl bg-gradient-to-tr from-indigo-600 to-violet-500 text-white font-bold text-sm shadow-lg shadow-indigo-600/30 hover:opacity-90 active:scale-95 transition-all"
        title={
          activeTab === 'today' || activeTab === 'finance'
            ? 'Add Expense or Income'
            : activeTab === 'diary'
              ? 'New note'
              : 'Quick Add Task'
        }
      >
        <Plus className="w-4 h-4" />
        <span>
          {activeTab === 'today' || activeTab === 'finance'
            ? 'New Entry'
            : activeTab === 'diary'
              ? 'New Note'
              : 'New Task'}
        </span>
      </button>}
    </aside>
  );
};

/** A swipe of this many px (mostly horizontal) opens or closes the drawer. */
const SWIPE_PX = 50;
/** Where the desktop Sidebar takes over (Tailwind `lg`). */
const DESKTOP_QUERY = '(min-width: 1024px)';
const FOCUSABLE = 'button:not([disabled]), [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';

interface MobileSidebarProps {
  isOpen: boolean;
  activeTab: ActiveTab;
  onOpen: () => void;
  onClose: () => void;
  onChangeTab: (tab: ActiveTab) => void;
  onOpenSettings: () => void;
}

/**
 * Slide-in navigation for phones and tablets (below lg). Opened from the header's
 * menu button or, on the website, by swiping right from the left screen edge;
 * closed by the backdrop, Escape, a left swipe, or choosing an item.
 *
 * No edge swipe in the Android app: with gesture navigation the system takes
 * left-edge swipes as Back, which would leave the tab (or minimise the app on Home).
 */
export const MobileSidebar: React.FC<MobileSidebarProps> = ({
  isOpen,
  activeTab,
  onOpen,
  onClose,
  onChangeTab,
  onOpenSettings,
}) => {
  const panelRef = useRef<HTMLDivElement>(null);
  const swipeStart = useRef<{ x: number; y: number } | null>(null);

  // While open: Escape closes, Tab stays inside the panel (it is aria-modal), and
  // focus goes back to whatever opened it (the menu button) on close.
  useEffect(() => {
    if (!isOpen) return;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onClose();
        return;
      }
      if (event.key !== 'Tab' || !panelRef.current) return;
      const focusable = Array.from(panelRef.current.querySelectorAll<HTMLElement>(FOCUSABLE)) as HTMLElement[];
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const inside = panelRef.current.contains(document.activeElement);
      if (event.shiftKey && (document.activeElement === first || !inside)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (document.activeElement === last || !inside)) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    panelRef.current?.querySelector<HTMLButtonElement>('[aria-current="page"]')?.focus({ preventScroll: true });
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      if (opener?.isConnected) opener.focus({ preventScroll: true });
    };
  }, [isOpen, onClose]);

  // The drawer is hidden from lg up, so close it when the window grows (e.g. a tablet
  // rotating to landscape); otherwise an invisible open drawer would eat the next Back.
  useEffect(() => {
    if (!isOpen || typeof window.matchMedia !== 'function') return;
    const desktop = window.matchMedia(DESKTOP_QUERY);
    if (desktop.matches) {
      onClose();
      return;
    }
    const onChange = (event: MediaQueryListEvent) => {
      if (event.matches) onClose();
    };
    desktop.addEventListener('change', onChange);
    return () => desktop.removeEventListener('change', onChange);
  }, [isOpen, onClose]);

  const startSwipe = (event: React.TouchEvent) => {
    const touch = event.touches[0];
    swipeStart.current = { x: touch.clientX, y: touch.clientY };
  };

  /** Fires `action` once the finger has moved far enough, mostly horizontally, in `direction`. */
  const trackSwipe = (direction: 1 | -1, action: () => void) => (event: React.TouchEvent) => {
    const start = swipeStart.current;
    if (!start) return;
    const touch = event.touches[0];
    const dx = (touch.clientX - start.x) * direction;
    const dy = Math.abs(touch.clientY - start.y);
    if (dx > SWIPE_PX && dx > dy * 1.5) {
      swipeStart.current = null;
      action();
    }
  };

  const endSwipe = () => {
    swipeStart.current = null;
  };

  const select = (tab: ActiveTab) => {
    onChangeTab(tab);
    onClose();
  };

  return (
    <>
      {/* Left-edge swipe zone (website only, see above). Below the header and any modal (z-50),
          and narrower than the page's side padding so it does not cover the DateBar arrow. */}
      {!isOpen && !isNative() && (
        <div
          aria-hidden="true"
          onTouchStart={startSwipe}
          onTouchMove={trackSwipe(1, onOpen)}
          onTouchEnd={endSwipe}
          onTouchCancel={endSwipe}
          className="fixed left-0 top-0 bottom-0 w-2 z-20 lg:hidden"
        />
      )}

      <div
        aria-hidden="true"
        onClick={onClose}
        className={`fixed inset-0 z-50 bg-slate-950/50 backdrop-blur-[1px] transition-opacity duration-200 lg:hidden ${
          isOpen ? 'opacity-100' : 'opacity-0 pointer-events-none'
        }`}
      />

      <div
        ref={panelRef}
        id="mobile-sidebar"
        role="dialog"
        aria-modal="true"
        aria-label="Navigation"
        inert={!isOpen}
        onTouchStart={startSwipe}
        onTouchMove={trackSwipe(-1, onClose)}
        onTouchEnd={endSwipe}
        onTouchCancel={endSwipe}
        className={`fixed left-0 top-0 bottom-0 z-50 w-72 max-w-[85vw] flex flex-col bg-white dark:bg-slate-900 border-r border-slate-200 dark:border-slate-800 shadow-2xl select-none transition-transform duration-200 ease-out lg:hidden ${
          isOpen ? 'translate-x-0' : '-translate-x-full'
        }`}
      >
        <div className="flex items-center justify-between gap-2 px-4 pt-[calc(1rem+env(safe-area-inset-top,0px))] pb-4 shrink-0">
          <Brand />
          <button
            type="button"
            onClick={onClose}
            aria-label="Close menu"
            className="min-h-[40px] min-w-[40px] rounded-xl flex items-center justify-center text-slate-500 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <nav className="flex flex-col gap-1 flex-1 min-h-0 overflow-y-auto overscroll-contain px-3">
          <NavList activeTab={activeTab} onSelect={select} />
        </nav>

        <div className="shrink-0 border-t border-slate-200 dark:border-slate-800 px-3 pt-2 pb-[calc(0.75rem+env(safe-area-inset-bottom,0px))] flex flex-col gap-1">
          <NavButton item={CATEGORIES_ITEM} activeTab={activeTab} onSelect={select} />
          <SettingsButton
            onClick={() => {
              onClose();
              onOpenSettings();
            }}
          />
        </div>
      </div>
    </>
  );
};
